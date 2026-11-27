// Everyone in the terminals: passengers from the flight book, the queues they pass through, the
// bags they check and collect, the shops they spend in, and the staff who serve them.
//
// A travel party walks as one: a person in the people store with a size. Departing parties reach
// the airport some time before their flight, by car to the curb, from a garage, by AirTrain or by
// BART; check bags if they have any; queue at their concourse's checkpoint; spend time in the
// shops if there is time; wait at their gate and board when it is their turn. Arriving parties
// come off the aircraft, clear customs if they flew from abroad, collect their bags and leave.
// The terminals count people off and on each flight and close its doors; a party not at the gate
// by then has missed the flight and goes home.

import type { Layout } from '../../shared/layout.ts';
import type { FlightBook, Visit } from '../airside/flights.ts';
import { CONFIG } from '../config.ts';
import { AIRCRAFT, AIRLINES, AIRLINE_BY_CODE } from '../fleet.ts';
import type { Rng } from '../rng.ts';
import { UNREACHABLE } from './grid.ts';
import { ACT, People, ROLE, STEP } from './people.ts';
import { FLOOR, FLOOR_HEIGHT, buildTerminalPlan, type Place, type PlaceKind, type TerminalPlan } from './plan.ts';
import { ServiceQueue } from './queue.ts';

/** The flight book's value for a time that has not happened yet. */
const NOT_YET = -1;
/** Most walkers at once: parties and staff. */
export const CAPACITY = 40_000;
/** How far ahead departing parties are planned, seconds. */
const LOOKAHEAD = 5 * 3600;
/** Seconds between the slower decisions: who arrives, which lanes are open, whose doors close. */
const HOUSEKEEPING = 5;
/** At a mid-day start, travellers who came more than this many seconds before are through security. */
const WARM_THROUGH = 2400;
/** Metres from its gate within which a party can be boarding that gate's flight. */
const GATE_REACH = 60;

const EVENT = { airside: 1, board: 2, atClaim: 3, leave: 4, shop: 5, roam: 6 } as const;
/** What a walker is, in the low bits of `people.flags`. */
const KIND = { departing: 1, arriving: 2, staff: 3 } as const;
const KIND_MASK = 3;
const INTERNATIONAL = 1 << 2;
const MISSED = 1 << 3;
/** An arriving party on its way out of the building. */
const LEAVING = 1 << 4;
/** A departing party that came in on another flight and changed here, never leaving the airside. */
const CONNECTING = 1 << 5;
/** Seconds between an arrival and an onward flight that a connection may have, at least and at most. */
const CONNECT_SHORTEST = 45 * 60;
const CONNECT_LONGEST = 4 * 3600;

/** Travel party sizes and how often each comes. */
const PARTY: [number, number][] = [[1, 52], [2, 30], [3, 11], [4, 7]];
/** How departing parties reach the airport, and how arriving ones leave it. */
const ARRIVE_BY: [PlaceKind, number][] = [['curb', 55], ['garage', 15], ['airtrain', 18], ['bart', 12]];
const LEAVE_BY: [PlaceKind, number][] = [['pickup', 52], ['garage', 16], ['airtrain', 18], ['bart', 14]];

/** Clothes: the first palette entries are uniforms; passengers wear anything after them. */
const UNIFORM: Record<number, number> = { [ROLE.security]: 0, [ROLE.agent]: 1, [ROLE.gate]: 2, [ROLE.shop]: 3, [ROLE.cleaner]: 6, [ROLE.officer]: 8 };
const FIRST_PLAIN = 9;
const PLAIN = 18;

export interface WaitStats {
  served: number;
  /** Count of waits in 20-second bins, up to an hour; the last bin holds anything longer. */
  histogram: Uint32Array;
  longest: number;
}

const newWaits = (): WaitStats => ({ served: 0, histogram: new Uint32Array(181), longest: 0 });

/** The wait that `share` of everyone served waited no longer than, seconds. */
export function percentile(stats: WaitStats, share: number): number {
  const total = stats.histogram.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let seen = 0;
  for (let i = 0; i < stats.histogram.length; i += 1) {
    seen += stats.histogram[i];
    if (seen >= share * total) return (i + 1) * 20;
  }
  return stats.histogram.length * 20;
}

export interface TerminalStats {
  /** People, not parties. */
  departing: { created: number; boarded: number; missed: number; cancelled: number };
  arriving: { created: number; left: number; alreadyGone: number };
  /**
   * Passengers who change here from one flight to another without leaving the airside: counted
   * among the departing as well, as the travellers of their onward flight.
   */
  connecting: { created: number; boarded: number; missed: number };
  /**
   * Departing bags: every one checked is at once loaded, left behind or misrouted; a cancelled
   * flight's loaded bags are returned. Arriving bags: every one that arrives is in time collected
   * or lost; delivered counts those put on a belt.
   */
  bags: { checked: number; loaded: number; leftBehind: number; misrouted: number; returned: number; arrived: number; delivered: number; collected: number; lost: number };
  security: WaitStats;
  checkin: WaitStats;
  customs: WaitStats;
  /** Money spent in shops and places to eat, dollars, by boarding area or hall. */
  takings: Record<string, number>;
}

interface Pending {
  at: number;
  visit: number;
  size: number;
  bags: number;
}

interface Post {
  /** Where the member of staff stands, and on which floor. */
  x: number;
  y: number;
  floor: number;
  role: number;
  person: number;
}

export class Terminals {
  readonly plan: TerminalPlan;
  readonly people: People;
  readonly stats: TerminalStats;
  /** Checkpoints closed, by place id, and where each boarding area's travellers go instead. */
  readonly closedCheckpoints = new Set<number>();
  private readonly divertedTo = new Map<string, Place>();
  /** What the terminals did that the operations log shows. */
  readonly events: { time: number; kind: string; text: string }[] = [];
  /** Checked bags in the bag system: pairs of the time each lot is ready to go out, and how many. */
  private readonly bagsMoving: number[] = [];
  /** Per arriving flight being deplaned: the flights its connecting passengers may change to. */
  private readonly onwardChoices = new Map<number, Visit[]>();
  /** Checked bags counted as loaded for each departure not yet gone, by visit: a cancellation gives them back. */
  private readonly bagsOnFlight = new Map<number, number>();
  /** Queues by place: check-in halls, checkpoints, customs, gates. */
  readonly queues = new Map<number, ServiceQueue>();
  private readonly queueId = new Map<number, number>();
  private readonly placeByQueue: Place[] = [];
  private readonly book: FlightBook;
  private readonly rng: Rng;
  private readonly layout: Layout;
  private readonly fieldId = new Map<number, number>();
  private readonly pointsAround = new Map<number, number[]>();
  private readonly holdroomOfStand = new Map<string, Place>();
  private readonly nearShops = new Map<number, Place[]>();
  private readonly shops: Place[];
  private readonly pending: Pending[] = [];
  private pendingAt = 0;
  private readonly planned = new Set<number>();
  /** Departing parties of each visit that have not boarded. */
  private readonly partiesOf = new Map<number, Set<number>>();
  private readonly deplaning = new Map<number, number>();
  private readonly boarding = new Set<number>();
  private readonly posts = new Map<string, Post>();
  /** Owner data per walker. */
  private readonly bags = new Uint8Array(CAPACITY);
  private readonly bagReady = new Float64Array(CAPACITY);
  private readonly lostBag = new Uint8Array(CAPACITY);
  private readonly claimAt = new Int16Array(CAPACITY).fill(-1);
  private nextHousekeeping = 0;
  private now: number;

  constructor(layout: Layout, book: FlightBook, rng: Rng, now: number) {
    this.layout = layout;
    this.book = book;
    this.rng = rng;
    this.now = now;
    this.plan = buildTerminalPlan(layout, AIRLINES);
    this.people = new People(CAPACITY, this.plan.grids, (floor) => FLOOR_HEIGHT[floor] ?? 0);
    this.stats = {
      departing: { created: 0, boarded: 0, missed: 0, cancelled: 0 },
      arriving: { created: 0, left: 0, alreadyGone: 0 },
      connecting: { created: 0, boarded: 0, missed: 0 },
      bags: { checked: 0, loaded: 0, leftBehind: 0, misrouted: 0, returned: 0, arrived: 0, delivered: 0, collected: 0, lost: 0 },
      security: newWaits(),
      checkin: newWaits(),
      customs: newWaits(),
      takings: {},
    };
    this.shops = this.plan.places.filter((p) => p.kind === 'shop' || p.kind === 'food' || p.kind === 'lounge');
    for (const s of layout.airfield.stands) {
      const own = this.plan.holdroom.get(s.id);
      if (own) {
        this.holdroomOfStand.set(s.id, own);
        continue;
      }
      // A remote stand boards from the nearest gate, by bus.
      let best: Place | null = null;
      let bestD = Infinity;
      for (const h of this.plan.holdroom.values()) {
        const d = Math.hypot(h.x - s.x, h.y - s.y);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      if (best) this.holdroomOfStand.set(s.id, best);
    }
    this.people.events = {
      notify: (person, event) => this.onNotify(person, event),
      called: (person, queue, _server, waited) => this.onCalled(person, queue, waited),
      served: (person, queue) => this.onServed(person, queue),
      left: () => undefined,
      serviceTime: (person, queue) => this.serviceTime(person, queue),
    };
    // Every desk, lane, booth and gate exists from the start, so the place can be drawn whole.
    for (const place of this.plan.places) {
      if (place.kind === 'checkpoint' || place.kind === 'checkin' || place.kind === 'customs' || place.kind === 'holdroom') this.queueAt(place);
    }
    this.housekeeping(true);
  }

  // ---- tables -----------------------------------------------------------------------------

  /** The script id of the walk to a place, made the first time it is needed. */
  private field(place: Place): number {
    let id = this.fieldId.get(place.id);
    if (id === undefined) {
      id = this.people.addField(place.floor, this.plan.field(place), place.x, place.y);
      this.fieldId.set(place.id, id);
    }
    return id;
  }

  /** Standing places near a place: on its floor, within `radius`, so a crowd spreads out. */
  private around(place: Place, radius: number, count: number): number[] {
    let list = this.pointsAround.get(place.id);
    if (!list) {
      list = [];
      const grid = this.plan.grids[place.floor];
      for (let k = 0; k < count * 3 && list.length < count; k += 1) {
        const angle = this.rng.range(0, Math.PI * 2);
        const r = Math.sqrt(this.rng.next()) * radius;
        const cell = grid.cellAt(place.x + Math.cos(angle) * r, place.y + Math.sin(angle) * r);
        // Not against a wall: a party standing there would poke through it.
        if (cell < 0 || grid.edge[cell]) continue;
        list.push(this.people.addPoint(grid.cx[cell] + this.rng.range(-0.6, 0.6), grid.cy[cell] + this.rng.range(-0.6, 0.6)));
      }
      if (!list.length) list.push(this.people.addPoint(place.x, place.y));
      this.pointsAround.set(place.id, list);
    }
    return list;
  }

  /** The queue at a place, made the first time it is needed. */
  private queueAt(place: Place): number {
    let id = this.queueId.get(place.id);
    if (id !== undefined) return id;
    let servers = 4;
    let length = 18;
    let width = 10;
    let heading = place.heading;
    if (place.kind === 'checkpoint') {
      // Lanes for the checkpoint's own busiest hour, at about 150 people a lane an hour, with a
      // margin: a checkpoint is built for the traffic it gets.
      servers = Math.max(8, Math.min(28, Math.ceil((this.peakHour(place) / 150) * 1.25)));
      length = 30;
      width = 20;
    } else if (place.kind === 'checkin') {
      servers = place.size ? Math.max(6, Math.min(20, Math.round(place.size / 20))) : 8;
      // Counters face the hall away from the road outside.
      const curb = this.nearestWay(place, 'curb');
      if (curb) heading = Math.atan2(place.y - curb.y, place.x - curb.x);
    } else if (place.kind === 'customs') {
      // Booths, kiosks and the Global Entry lanes together.
      servers = place.size ? Math.max(24, Math.min(48, Math.round(place.size / 25))) : 30;
      length = 24;
      width = 18;
    } else if (place.kind === 'holdroom') {
      servers = 2;
      length = 10;
      width = 3;
    }
    const spacing = place.kind === 'holdroom' ? 1.6 : 2.4;
    // Of the four ways the line could face, the one whose desks and waiting area lie most inside
    // the floor; if none fits well, a shorter line.
    const grid = this.plan.grids[place.floor];
    const fit = (h: number, len: number): number => {
      const ux = Math.cos(h);
      const uy = Math.sin(h);
      let inside = 0;
      let total = 0;
      const halfWide = Math.max(width, servers * spacing) / 2;
      for (let a = 0; a <= len + 2; a += 3) {
        for (let b = -halfWide; b <= halfWide; b += 3) {
          total += 1;
          if (grid.cellAt(place.x - ux * a - uy * b, place.y - uy * a + ux * b) >= 0) inside += 1;
        }
      }
      return inside / Math.max(1, total);
    };
    let best = { heading, length, score: -1 };
    for (const len of [length, length / 2]) {
      for (const turn of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
        const score = fit(heading + turn, len) - (turn === 0 ? 0 : 0.02);
        if (score > best.score) best = { heading: heading + turn, length: len, score };
      }
      if (best.score > 0.85) break;
    }
    heading = best.heading;
    length = best.length;
    place.heading = heading;
    const ux = Math.cos(heading);
    const uy = Math.sin(heading);
    const front: { x: number; y: number }[] = [];
    for (let i = 0; i < servers; i += 1) {
      const across = (i - (servers - 1) / 2) * spacing;
      front.push({ x: place.x - uy * across, y: place.y + ux * across });
    }
    const queue = new ServiceQueue({ x: place.x - ux * (length / 2 + 2), y: place.y - uy * (length / 2 + 2), heading, length, width }, front);
    queue.setOpen(place.kind === 'holdroom' ? servers : Math.min(2, servers));
    id = this.people.addQueue(queue);
    this.queueId.set(place.id, id);
    this.placeByQueue[id] = place;
    this.queues.set(place.id, queue);
    return id;
  }

  /**
   * The most people who reach a checkpoint in any hour of the day, judged from the schedule: each
   * flight's passengers come through about an hour and a half before it leaves.
   */
  private peakHour(checkpoint: Place): number {
    const byHour = new Float64Array(24);
    for (const visit of this.book.visits.values()) {
      if (this.plan.checkpoint.get(this.areaOf(visit)) !== checkpoint) continue;
      const at = visit.rotation.dep - 5400;
      byHour[(((Math.floor(at / 3600) % 24) + 24) % 24)] += visit.rotation.paxOut;
    }
    // The book holds two days of the same timetable.
    const days = Math.max(1, new Set([...this.book.visits.values()].map((v) => Math.floor(v.std / 86400))).size);
    return Math.max(...byHour) / days;
  }

  private nearestWay(from: { x: number; y: number }, kind: PlaceKind): Place | null {
    let best: Place | null = null;
    let bestD = Infinity;
    for (const way of this.plan.ways) {
      if (way.kind !== kind) continue;
      const d = Math.hypot(way.x - from.x, way.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = way;
      }
    }
    return best;
  }

  private shopsNear(holdroom: Place): Place[] {
    let list = this.nearShops.get(holdroom.id);
    if (!list) {
      list = this.shops
        .filter((s) => s.floor === FLOOR.airside)
        .map((s) => ({ s, d: Math.hypot(s.x - holdroom.x, s.y - holdroom.y) }))
        .filter((e) => e.d < 450)
        .sort((a, b) => a.d - b.d)
        .slice(0, 8)
        .map((e) => e.s);
      this.nearShops.set(holdroom.id, list);
    }
    return list;
  }

  private holdroomOf(visit: Visit): Place | null {
    return this.holdroomOfStand.get(visit.stand) ?? null;
  }

  private areaOf(visit: Visit): string {
    return this.holdroomOf(visit)?.area ?? 'B';
  }

  private signalOf(visit: Visit): number {
    return visit.id % 4096;
  }

  private kind(person: number): number {
    return this.people.flags[person] & KIND_MASK;
  }

  private partySize(): number {
    return this.rng.weighted(PARTY, (p) => p[1])[0];
  }

  private colour(): number {
    return FIRST_PLAIN + this.rng.int(PLAIN);
  }

  private speed(size: number): number {
    return this.rng.range(1.1, 1.45) * (size >= 3 ? 0.88 : 1);
  }

  // ---- the passage of time ------------------------------------------------------------------

  step(now: number, dt: number): void {
    this.now = now;
    if (now >= this.nextHousekeeping) this.housekeeping(false);
    this.spawnDue(now);
    this.people.step(now, dt, 0, 1);
    this.people.stepQueues(now);
  }

  private housekeeping(first: boolean): void {
    const now = this.now;
    this.nextHousekeeping = now + HOUSEKEEPING;
    this.planDepartures(now, first);
    this.startDeplaning(now, first);
    this.manageBoarding(now);
    this.manageLanes(now);
    this.manageStaff(now);
    this.pruneBags();
  }

  /** Departing parties for every flight leaving within the lookahead, at the times they reach the airport. */
  private planDepartures(now: number, first: boolean): void {
    let added = false;
    for (const visit of this.book.visits.values()) {
      if (this.planned.has(visit.id) || visit.std > now + LOOKAHEAD || visit.std < now - 1800) continue;
      if (visit.state === 'done' || visit.doorsClosed) continue;
      this.planned.add(visit.id);
      this.partiesOf.set(visit.id, new Set());
      const international = visit.rotation.internationalOut;
      // The airline's connecting passengers fill the rest, coming off its arrivals airside.
      let left = Math.round(visit.rotation.paxOut * (1 - (AIRLINE_BY_CODE[visit.rotation.airline]?.connecting ?? 0)));
      while (left > 0) {
        const size = Math.min(left, this.partySize());
        left -= size;
        // How early people come: earlier for flights abroad, never later than the bag cut-off.
        const lead = international ? this.rng.bounded(9600, 1800, 5400, 15000) : this.rng.bounded(6300, 1500, 3000, 12000);
        const hasBags = this.rng.chance(international ? 0.85 : 0.55);
        const bags = hasBags ? Math.max(1, Math.round(size * this.rng.range(0.6, 1.2))) : 0;
        this.pending.push({ at: visit.std - lead, visit: visit.id, size, bags });
        added = true;
      }
    }
    if (added) {
      // Keep what is still to come in time order; the front is consumed by spawnDue.
      const rest = this.pending.splice(this.pendingAt).sort((a, b) => a.at - b.at || a.visit - b.visit);
      this.pending.length = 0;
      this.pending.push(...rest);
      this.pendingAt = 0;
    }
    if (first) this.spawnDue(now);
  }

  private spawnDue(now: number): void {
    while (this.pendingAt < this.pending.length && this.pending[this.pendingAt].at <= now) {
      const p = this.pending[this.pendingAt];
      this.pendingAt += 1;
      const visit = this.book.visits.get(p.visit);
      if (!visit) continue;
      this.spawnDeparting(visit, p.size, p.bags, now - p.at);
    }
    if (this.pendingAt > 4096) {
      this.pending.splice(0, this.pendingAt);
      this.pendingAt = 0;
    }
  }

  /**
   * Close a security checkpoint to new travellers, or open it again. Each boarding area it serves
   * is sent to the nearest open checkpoint from which its gates can be walked to, landside and
   * airside; anyone already on the way is still served. Refused, with the reason, when some area
   * would be left with no way through security.
   */
  setCheckpointClosed(placeId: number, closed: boolean): string | null {
    const place = this.plan.places[placeId];
    if (!place || place.kind !== 'checkpoint' || this.closedCheckpoints.has(placeId) === closed) return null;
    const next = new Set(this.closedCheckpoints);
    if (closed) next.add(placeId);
    else next.delete(placeId);
    const diverted = new Map<string, Place>();
    for (const [area, own] of this.plan.checkpoint) {
      if (!next.has(own.id)) continue;
      const out = this.plan.exit.get(area);
      if (!out) continue;
      const toGates = this.plan.field(out);
      let best: Place | null = null;
      let bestDistance = Infinity;
      for (const [other, cp] of this.plan.checkpoint) {
        const otherOut = this.plan.exit.get(other);
        if (next.has(cp.id) || !otherOut) continue;
        // Reachable before security from the closed one, and after it to this area's gates.
        if (this.plan.field(cp)[own.cell] === UNREACHABLE || toGates[otherOut.cell] === UNREACHABLE) continue;
        const d = Math.hypot(cp.x - own.x, cp.y - own.y);
        if (d < bestDistance) {
          bestDistance = d;
          best = cp;
        }
      }
      if (!best) return `No other way through security to the gates of ${area}`;
      diverted.set(area, best);
    }
    this.closedCheckpoints.clear();
    for (const id of next) this.closedCheckpoints.add(id);
    this.divertedTo.clear();
    for (const [area, cp] of diverted) this.divertedTo.set(area, cp);
    const to = [...new Set([...diverted.values()].map((cp) => cp.name))].join(', ');
    this.event('security', closed ? `${place.name} closed${to ? `: travellers sent to ${to}` : ''}` : `${place.name} open again`);
    return null;
  }

  private event(kind: string, text: string): void {
    this.events.push({ time: this.now, kind, text });
    if (this.events.length > 200) this.events.splice(0, 100);
  }

  /** A departing party arrives; `late` is how long ago it should have, at a mid-day start. */
  private spawnDeparting(visit: Visit, size: number, bags: number, late: number): void {
    const area = this.areaOf(visit);
    const checkpoint = this.divertedTo.get(area) ?? this.plan.checkpoint.get(area) ?? [...this.plan.checkpoint.values()][0];
    const holdroom = this.holdroomOf(visit);
    if (!checkpoint || !holdroom) return;
    const sinceStart = late;
    const boardingAt = visit.etd - CONFIG.turnaround.boardingStarts[AIRCRAFT[visit.rotation.type].body] * 60;
    this.stats.departing.created += size;
    // A party with nowhere to be put, or no room for another walker, is taken to board unseen,
    // bags and all, so that the books still balance.
    const unseen = (): void => {
      visit.boarded += size;
      this.stats.departing.boarded += size;
      this.stats.bags.checked += bags;
      this.stats.bags.loaded += bags;
    };
    // Started in mid-day after this flight began boarding: the party is on board.
    if (sinceStart > 0 && this.now >= boardingAt && !visit.doorsClosed) {
      unseen();
      return;
    }
    // Started in mid-day: someone who came more than a usual trip through check-in and security
    // before now is already through, waiting near the gate, any bags checked and on their way.
    if (sinceStart > WARM_THROUGH || (sinceStart > 0 && this.now > boardingAt - 1800)) {
      const spot = this.around(holdroom, 16, 30);
      const id = this.addParty(KIND.departing, FLOOR.airside, holdroom.x, holdroom.y, size, visit);
      if (id < 0) {
        unseen();
        return;
      }
      this.stats.bags.checked += bags;
      this.stats.bags.loaded += bags;
      this.bagsOnFlight.set(visit.id, (this.bagsOnFlight.get(visit.id) ?? 0) + bags);
      this.people.setScript(id, [STEP.point, this.rng.pick(spot), STEP.until, this.signalOf(visit), STEP.walk, this.field(holdroom), STEP.queue, this.queueAt(holdroom), STEP.notify, EVENT.board]);
      return;
    }
    const by = this.rng.weighted(ARRIVE_BY, (e) => e[1])[0];
    // Of an airline's halls, the bigger ones take more of its passengers.
    const halls = this.plan.checkin.get(visit.rotation.airline);
    const checkin = halls?.length ? this.rng.weighted(halls, (h) => Math.max(200, h.size)) : undefined;
    const way = this.nearestWay(bags && checkin ? checkin : checkpoint, by) ?? this.nearestWay(checkpoint, 'curb');
    const id = way ? this.addParty(KIND.departing, way.floor, way.x, way.y, size, visit) : -1;
    if (!way || id < 0) {
      unseen();
      return;
    }
    this.bags[id] = bags;
    const steps: number[] = [];
    if (way.floor !== FLOOR.landside) steps.push(STEP.floor, FLOOR.landside);
    if (bags && checkin) steps.push(STEP.walk, this.field(checkin), STEP.queue, this.queueAt(checkin));
    steps.push(STEP.walk, this.field(checkpoint), STEP.queue, this.queueAt(checkpoint), STEP.floor, FLOOR.airside, STEP.notify, EVENT.airside);
    this.people.setScript(id, steps);
  }

  private addParty(kind: number, floor: number, x: number, y: number, size: number, visit: Visit | null): number {
    const id = this.people.add(ROLE.passenger, floor, x, y, this.speed(size), this.colour(), this.rng.int(0x10000) | (this.rng.int(0x10000) << 16), size);
    if (id < 0) return -1;
    this.people.flags[id] = kind | (visit && (kind === KIND.departing ? visit.rotation.internationalOut : visit.rotation.customs) ? INTERNATIONAL : 0);
    this.people.visit[id] = visit ? visit.id : -1;
    this.bags[id] = 0;
    this.bagReady[id] = 0;
    this.lostBag[id] = 0;
    this.claimAt[id] = -1;
    if (visit && kind === KIND.departing) this.partiesOf.get(visit.id)?.add(id);
    return id;
  }

  /** What happens next for a departing party just through security. */
  private afterSecurity(person: number, visit: Visit): void {
    const holdroom = this.holdroomOf(visit);
    if (!holdroom) return;
    if (visit.doorsClosed) {
      this.missed(person);
      return;
    }
    const boardingAt = visit.etd - CONFIG.turnaround.boardingStarts[AIRCRAFT[visit.rotation.type].body] * 60;
    const spare = boardingAt - this.now;
    const toGate = [STEP.walk, this.field(holdroom), STEP.point, this.rng.pick(this.around(holdroom, 16, 30)), STEP.until, this.signalOf(visit), STEP.walk, this.field(holdroom), STEP.queue, this.queueAt(holdroom), STEP.notify, EVENT.board];
    const shops = this.shopsNear(holdroom);
    if (visit.boardingOpen || spare < 1500 || !shops.length || !this.rng.chance(0.7)) {
      this.people.setScript(person, toGate);
      return;
    }
    const shop = this.rng.pick(shops);
    const dwell = Math.min(spare - 900, this.rng.range(600, 2400));
    this.claimAt[person] = shop.id;
    this.people.setScript(person, [STEP.walk, this.field(shop), STEP.point, this.rng.pick(this.around(shop, 7, 10)), STEP.notify, EVENT.shop, STEP.wait, Math.round(dwell), ...toGate]);
  }

  /** The flight left without this departing party, or never came: it goes home. */
  private missed(person: number, cancelled = false): void {
    const people = this.people;
    people.flags[person] |= MISSED;
    const visit = this.book.visits.get(people.visit[person]);
    if (cancelled) this.stats.departing.cancelled += people.size[person];
    else this.stats.departing.missed += people.size[person];
    if (!cancelled && people.flags[person] & CONNECTING) this.stats.connecting.missed += people.size[person];
    if (visit) this.partiesOf.get(visit.id)?.delete(person);
    this.leaveBuilding(person, visit ? this.areaOf(visit) : 'B', 'pickup');
  }

  /** Script the way out of the building from wherever the walker is. */
  private leaveBuilding(person: number, area: string, by: PlaceKind): void {
    const people = this.people;
    const steps: number[] = [];
    const here = { x: people.x[person], y: people.y[person] };
    if (people.floor[person] === FLOOR.airside) {
      const out = this.plan.exit.get(area) ?? [...this.plan.exit.values()][0];
      if (out) steps.push(STEP.walk, this.field(out));
      steps.push(STEP.floor, by === 'pickup' ? FLOOR.arrivals : FLOOR.landside);
      if (out) {
        here.x = out.x;
        here.y = out.y;
      }
    } else {
      const floor = by === 'pickup' ? FLOOR.arrivals : FLOOR.landside;
      if (people.floor[person] !== floor) steps.push(STEP.floor, floor);
    }
    const way = this.nearestWay(here, by) ?? this.nearestWay(here, 'pickup');
    if (way) steps.push(STEP.walk, this.field(way));
    steps.push(STEP.notify, EVENT.leave, STEP.leave, 0);
    people.setScript(person, steps);
  }

  // ---- arrivals ------------------------------------------------------------------------------

  private startDeplaning(now: number, first: boolean): void {
    for (const visit of this.book.visits.values()) {
      // -1 means not yet; a real time can be negative, for an aircraft that arrived the day before.
      if (visit.onBlockAt === NOT_YET || visit.deplaned >= visit.rotation.paxIn || this.deplaning.has(visit.id)) continue;
      // Already off and away before the simulation started.
      if (first && now - visit.onBlockAt > 1800) {
        this.stats.arriving.alreadyGone += visit.rotation.paxIn - visit.deplaned;
        visit.deplaned = visit.rotation.paxIn;
        continue;
      }
      // Doors open once the bridge or the stairs are on.
      this.deplaning.set(visit.id, Math.max(now, visit.onBlockAt + this.rng.range(CONFIG.turnaround.bridgeOn[0], CONFIG.turnaround.bridgeOn[1])));
    }
    for (const [id, next] of this.deplaning) {
      const visit = this.book.visits.get(id);
      if (!visit || visit.deplaned >= visit.rotation.paxIn) {
        this.deplaning.delete(id);
        this.onwardChoices.delete(id);
        continue;
      }
      let at = next;
      const doors = AIRCRAFT[visit.rotation.type].doors;
      while (at <= now + HOUSEKEEPING && visit.deplaned < visit.rotation.paxIn) {
        const size = Math.min(visit.rotation.paxIn - visit.deplaned, this.partySize());
        visit.deplaned += size;
        this.spawnArriving(visit, size);
        at += (size * 1.3) / doors;
      }
      this.deplaning.set(id, at);
    }
  }

  /**
   * A flight of the same airline that a passenger off `arrival` could change to: leaving between
   * three quarters of an hour and four hours from now, still taking passengers, its travellers
   * already planned, and its gate one that can be walked to from `from` without leaving the
   * airside. Null when there is none. The choices are worked out once per arriving flight.
   */
  private onwardFlight(arrival: Visit, from: Place): Visit | null {
    let choices = this.onwardChoices.get(arrival.id);
    if (!choices) {
      choices = [];
      for (const v of this.book.visits.values()) {
        if (v.id === arrival.id || v.rotation.airline !== arrival.rotation.airline || v.doorsClosed || v.state === 'done' || !this.partiesOf.has(v.id)) continue;
        const wait = v.etd - this.now;
        if (wait < CONNECT_SHORTEST || wait > CONNECT_LONGEST) continue;
        const gate = this.holdroomOf(v);
        if (!gate || this.plan.field(gate)[from.cell] === UNREACHABLE) continue;
        choices.push(v);
      }
      this.onwardChoices.set(arrival.id, choices);
    }
    const open = choices.filter((v) => !v.doorsClosed);
    return open.length ? this.rng.pick(open) : null;
  }

  private spawnArriving(visit: Visit, size: number): void {
    const holdroom = this.holdroomOf(visit);
    if (!holdroom) return;
    const international = visit.rotation.customs;
    // Some of an airline's passengers change here for another of its flights, walking airside to
    // its gate: those who need not clear customs first, to a gate they can walk to.
    if (!international && this.rng.chance(AIRLINE_BY_CODE[visit.rotation.airline]?.connecting ?? 0)) {
      const onward = this.onwardFlight(visit, holdroom);
      if (onward) {
        const id = this.addParty(KIND.departing, FLOOR.airside, holdroom.x, holdroom.y, size, onward);
        this.stats.departing.created += size;
        this.stats.connecting.created += size;
        if (id < 0) {
          // No room for another walker: counted as having made the connection.
          onward.boarded += size;
          this.stats.departing.boarded += size;
          this.stats.connecting.boarded += size;
          return;
        }
        this.people.flags[id] |= CONNECTING;
        // From here on as anyone else through security: the shops if there is time, then the gate.
        this.people.setScript(id, [STEP.notify, EVENT.airside]);
        return;
      }
    }
    // From a gate with no customs hall of its own, international passengers are bussed to the
    // nearest one, and leave the building from there.
    let start: Place = holdroom;
    let area = holdroom.area;
    if (international && !this.plan.customs.has(area)) {
      let best: Place | null = null;
      for (const c of this.plan.customs.values()) if (!best || Math.hypot(c.x - holdroom.x, c.y - holdroom.y) < Math.hypot(best.x - holdroom.x, best.y - holdroom.y)) best = c;
      if (best) {
        start = best;
        area = best.area;
      }
    }
    const id = this.addParty(KIND.arriving, FLOOR.airside, start.x, start.y, size, visit);
    this.stats.arriving.created += size;
    if (id < 0) {
      this.stats.arriving.left += size;
      return;
    }
    const hasBags = this.rng.chance(international ? 0.85 : 0.5);
    const bags = hasBags ? Math.max(1, Math.round(size * this.rng.range(0.6, 1.2))) : 0;
    this.bags[id] = bags;
    this.stats.bags.arrived += bags;
    if (bags) {
      // Bags start coming round a quarter of an hour after the aircraft parks, over a spread that
      // grows with the number of people aboard.
      const first = visit.onBlockAt + (AIRCRAFT[visit.rotation.type].body === 'wide' || AIRCRAFT[visit.rotation.type].body === 'super' ? 1100 : 780);
      const spread = Math.min(1500, 360 + visit.rotation.paxIn * 3);
      let ready = 0;
      for (let b = 0; b < bags; b += 1) {
        ready = Math.max(ready, first + this.rng.range(0, spread));
        if (this.rng.chance(0.003)) this.lostBag[id] = 1;
      }
      this.bagReady[id] = ready;
    }
    const steps: number[] = [];
    const customs = international ? this.plan.customs.get(area) ?? [...this.plan.customs.values()][0] : undefined;
    if (customs) steps.push(STEP.walk, this.field(customs), STEP.queue, this.queueAt(customs));
    const out = this.plan.exit.get(area) ?? [...this.plan.exit.values()][0];
    if (out) steps.push(STEP.walk, this.field(out));
    steps.push(STEP.floor, FLOOR.arrivals);
    const claims = this.plan.claim.get(area);
    const claim = claims ? (international ? claims.international : claims.domestic) : undefined;
    if (bags && claim) {
      this.claimAt[id] = claim.id;
      steps.push(STEP.walk, this.field(claim), STEP.notify, EVENT.atClaim);
    } else {
      steps.push(STEP.notify, EVENT.leave);
    }
    this.people.setScript(id, steps);
  }

  // ---- events from the walkers ----------------------------------------------------------------

  private onNotify(person: number, event: number): void {
    const people = this.people;
    const visit = this.book.visits.get(people.visit[person]);
    switch (event) {
      case EVENT.airside:
        if (visit) this.afterSecurity(person, visit);
        else this.leaveBuilding(person, 'B', 'pickup');
        return;
      case EVENT.shop: {
        const shop = this.plan.places[this.claimAt[person]];
        if (shop) {
          const spend = shop.kind === 'food' ? this.rng.range(8, 28) : shop.kind === 'shop' ? (this.rng.chance(0.35) ? this.rng.range(12, 90) : 0) : 0;
          const key = shop.area || this.nearestArea(shop);
          this.stats.takings[key] = (this.stats.takings[key] ?? 0) + spend * people.size[person];
        }
        this.claimAt[person] = -1;
        return;
      }
      case EVENT.board: {
        if (!visit || visit.doorsClosed) {
          this.missed(person);
          return;
        }
        // The gate changed while they made their way: on to the one the aircraft is at now.
        const gate = this.holdroomOf(visit);
        if (gate && Math.hypot(people.x[person] - gate.x, people.y[person] - gate.y) > GATE_REACH) {
          people.setScript(person, [STEP.walk, this.field(gate), STEP.queue, this.queueAt(gate), STEP.notify, EVENT.board]);
          return;
        }
        visit.boarded += people.size[person];
        this.stats.departing.boarded += people.size[person];
        if (people.flags[person] & CONNECTING) this.stats.connecting.boarded += people.size[person];
        this.partiesOf.get(visit.id)?.delete(person);
        people.setScript(person, [STEP.leave, 0]);
        return;
      }
      case EVENT.atClaim: {
        const claim = this.plan.places[this.claimAt[person]];
        const wait = Math.max(0, this.bagReady[person] - this.now) + (this.lostBag[person] ? 900 : 0);
        this.stats.bags.delivered += this.lostBag[person] ? 0 : this.bags[person];
        const spot = claim ? this.rng.pick(this.around(claim, 14, 40)) : -1;
        people.setScript(person, spot >= 0 ? [STEP.point, spot, STEP.wait, Math.round(wait), STEP.notify, EVENT.leave] : [STEP.wait, Math.round(wait), STEP.notify, EVENT.leave]);
        return;
      }
      case EVENT.leave: {
        // Arriving parties report twice: once ready to leave, to choose the way out, and once at it.
        if (this.kind(person) !== KIND.arriving) return;
        if (people.flags[person] & LEAVING) {
          this.stats.arriving.left += people.size[person];
          return;
        }
        people.flags[person] |= LEAVING;
        // Their bags are settled as they go: collected, or reported lost.
        if (this.bags[person]) {
          if (this.lostBag[person]) this.stats.bags.lost += this.bags[person];
          else this.stats.bags.collected += this.bags[person];
          this.bags[person] = 0;
        }
        this.claimAt[person] = -1;
        const area = visit ? this.holdroomOf(visit)?.area ?? 'B' : 'B';
        this.leaveBuilding(person, area, this.rng.weighted(LEAVE_BY, (e) => e[1])[0]);
        return;
      }
      case EVENT.roam:
        this.roam(person);
        return;
      default:
        return;
    }
  }

  private nearestArea(place: { x: number; y: number }): string {
    let best = 'B';
    let bestD = Infinity;
    for (const [letter, cp] of this.plan.checkpoint) {
      const d = Math.hypot(cp.x - place.x, cp.y - place.y);
      if (d < bestD) {
        bestD = d;
        best = letter;
      }
    }
    return best;
  }

  private placeOfQueue(queue: number): Place | null {
    return this.placeByQueue[queue] ?? null;
  }

  private onCalled(person: number, queue: number, waited: number): void {
    const place = this.placeOfQueue(queue);
    if (!place) return;
    const stats = place.kind === 'checkpoint' ? this.stats.security : place.kind === 'checkin' ? this.stats.checkin : place.kind === 'customs' ? this.stats.customs : null;
    if (!stats) return;
    stats.served += this.people.size[person];
    stats.histogram[Math.min(stats.histogram.length - 1, Math.floor(waited / 20))] += this.people.size[person];
    stats.longest = Math.max(stats.longest, waited);
  }

  private onServed(person: number, queue: number): void {
    const place = this.placeOfQueue(queue);
    if (!place || place.kind !== 'checkin') return;
    // Bags go into the system: sorted, screened and taken to the aircraft in time, or not.
    const bags = this.bags[person];
    if (!bags) return;
    const visit = this.book.visits.get(this.people.visit[person]);
    this.stats.bags.checked += bags;
    const ready = this.now + this.rng.range(480, 1500);
    if (!visit || ready > visit.etd - 900) this.stats.bags.leftBehind += bags;
    else if (this.rng.chance(0.002)) this.stats.bags.misrouted += bags;
    else {
      this.stats.bags.loaded += bags;
      this.bagsOnFlight.set(visit.id, (this.bagsOnFlight.get(visit.id) ?? 0) + bags);
    }
    // Each is in the bag system, being sorted and screened, until it is ready to go out to its aircraft.
    this.bagsMoving.push(ready, bags);
    this.bags[person] = 0;
  }

  /** Arriving bags not yet collected or reported lost: on their way to a belt, or on one. */
  arrivingBagsInside(): number {
    let n = 0;
    const people = this.people;
    for (let id = 0; id < people.high; id += 1) if (people.alive[id] && (people.flags[id] & KIND_MASK) === KIND.arriving) n += this.bags[id];
    return n;
  }

  /** Checked bags still being sorted and screened in the bag system. */
  bagsInSystem(): number {
    let n = 0;
    for (let i = 0; i < this.bagsMoving.length; i += 2) if (this.bagsMoving[i] > this.now) n += this.bagsMoving[i + 1];
    return n;
  }

  /** Forget the lots of bags that have left the bag system. */
  private pruneBags(): void {
    let kept = 0;
    for (let i = 0; i < this.bagsMoving.length; i += 2) {
      if (this.bagsMoving[i] <= this.now) continue;
      this.bagsMoving[kept] = this.bagsMoving[i];
      this.bagsMoving[kept + 1] = this.bagsMoving[i + 1];
      kept += 2;
    }
    this.bagsMoving.length = kept;
  }

  private serviceTime(person: number, queue: number): number {
    const size = this.people.size[person] || 1;
    const place = this.placeOfQueue(queue);
    switch (place?.kind) {
      // About 150 people an hour through a lane, as screening goes.
      case 'checkpoint':
        return (10 + 16 * size) * this.rng.range(0.7, 1.4);
      // Most people have checked in online and only drop their bags.
      case 'checkin':
        return (35 + 18 * this.bags[person]) * this.rng.range(0.7, 1.6);
      case 'customs':
        return (25 + 15 * size) * this.rng.range(0.6, 1.6);
      case 'holdroom':
        return 4 * size * this.rng.range(0.8, 1.4);
      default:
        return 20;
    }
  }

  // ---- gates ---------------------------------------------------------------------------------

  /** Open boarding when the airside does, and close the doors when the time comes. */
  private manageBoarding(now: number): void {
    for (const visit of this.book.visits.values()) {
      const signal = this.signalOf(visit);
      if (visit.boardingOpen && !this.boarding.has(visit.id)) {
        this.boarding.add(visit.id);
        this.people.setSignal(signal, true);
        // Anyone waiting at the gate the flight used to have goes to the one it has now.
        const holdroom = this.holdroomOf(visit);
        for (const person of this.partiesOf.get(visit.id) ?? []) {
          if (!holdroom || this.people.floor[person] !== FLOOR.airside || this.people.act[person] === ACT.queued) continue;
          if (Math.hypot(this.people.x[person] - holdroom.x, this.people.y[person] - holdroom.y) > 40 && this.people.act[person] === ACT.wait) {
            this.people.setScript(person, [STEP.walk, this.field(holdroom), STEP.queue, this.queueAt(holdroom), STEP.notify, EVENT.board]);
          }
        }
      }
      if (!this.boarding.has(visit.id)) {
        // A flight that never came: after four hours its passengers go home.
        if (!visit.doorsClosed && visit.std < now - 4 * 3600 && visit.onBlockAt === NOT_YET && this.partiesOf.get(visit.id)?.size) {
          visit.doorsClosed = true;
          for (const person of [...(this.partiesOf.get(visit.id) ?? [])]) this.missed(person, true);
          // Their bags never flew: they go back to their owners.
          const bags = this.bagsOnFlight.get(visit.id) ?? 0;
          this.stats.bags.loaded -= bags;
          this.stats.bags.returned += bags;
          this.bagsOnFlight.delete(visit.id);
        }
        continue;
      }
      const remaining = this.partiesOf.get(visit.id);
      const closeAt = visit.etd - CONFIG.turnaround.doorsClose * 60;
      const everyone = !remaining || remaining.size === 0;
      if (now >= closeAt && (everyone || now >= visit.etd - 120)) {
        visit.doorsClosed = true;
        visit.boardingOpen = false;
        this.boarding.delete(visit.id);
        this.people.setSignal(signal, false);
        for (const person of [...(remaining ?? [])]) this.missed(person);
        this.partiesOf.delete(visit.id);
        // Its bags are aboard and gone with it.
        this.bagsOnFlight.delete(visit.id);
      }
    }
  }

  // ---- lanes and staff -----------------------------------------------------------------------

  /** Open as many lanes, desks and booths as the line needs, within what the place has. */
  private manageLanes(now: number): void {
    const hour = (now / 3600) % 24;
    const night = hour < 4.5 || hour > 23.5;
    for (const [placeId, queue] of this.queues) {
      const place = this.plan.places[placeId];
      if (place.kind === 'holdroom') continue;
      let people = 0;
      for (const p of queue.line) people += this.people.size[p] || 1;
      // Mean seconds a server spends per person.
      const mean = place.kind === 'checkpoint' ? 24 : place.kind === 'checkin' ? 32 : 45;
      // Enough servers to bring the wait down to ten minutes, at least one, two by day. A closed
      // checkpoint takes nobody new, but works through whoever is in line, then shuts.
      const want = Math.ceil((people * mean) / 600);
      const least = this.closedCheckpoints.has(placeId) ? (people > 0 ? 1 : 0) : night ? 1 : 2;
      const open = Math.max(least, Math.min(queue.servers.length, want));
      // Lanes open at once but close one at a time, so a short lull does not empty them.
      const now0 = queue.openServers;
      queue.setOpen(open >= now0 ? open : now0 - 1);
    }
  }

  private manageStaff(now: number): void {
    const wanted = new Map<string, Omit<Post, 'person'>>();
    for (const [placeId, queue] of this.queues) {
      const place = this.plan.places[placeId];
      const role = place.kind === 'checkpoint' ? ROLE.security : place.kind === 'checkin' ? ROLE.agent : place.kind === 'customs' ? ROLE.officer : ROLE.gate;
      if (place.kind === 'holdroom' && !this.boardingAt(place)) continue;
      queue.servers.forEach((s, i) => {
        if (!s.open) return;
        const ux = Math.cos(place.heading);
        const uy = Math.sin(place.heading);
        // Behind the desk or the belt, facing whoever is being served.
        wanted.set(`${placeId}:${i}`, { x: s.x + ux * 1.4, y: s.y + uy * 1.4, floor: place.floor, role });
      });
    }
    const hour = (now / 3600) % 24;
    if (hour > 5 && hour < 23.5) {
      for (const shop of this.shops) {
        if (shop.kind === 'lounge') continue;
        wanted.set(`shop:${shop.id}`, { x: shop.x, y: shop.y, floor: shop.floor, role: ROLE.shop });
      }
    }
    for (const [key, post] of this.posts) {
      if (wanted.has(key) && this.people.alive[post.person]) continue;
      if (this.people.alive[post.person]) this.leaveBuilding(post.person, this.nearestArea(post), 'garage');
      this.posts.delete(key);
    }
    for (const [key, want] of wanted) {
      if (this.posts.has(key)) continue;
      const id = this.people.add(want.role, want.floor, want.x, want.y, 1.3, UNIFORM[want.role] ?? 0, this.rng.int(0x7fffffff), 1);
      if (id < 0) continue;
      this.people.flags[id] = KIND.staff;
      this.people.setScript(id, [STEP.wait, 1e8]);
      this.posts.set(key, { ...want, person: id });
    }
    this.manageCleaners(now);
  }

  private boardingAt(holdroom: Place): boolean {
    const queue = this.queues.get(holdroom.id);
    return Boolean(queue && queue.size > 0);
  }

  private cleaners: number[] = [];

  private manageCleaners(now: number): void {
    const hour = (now / 3600) % 24;
    const want = hour > 5 && hour < 23 ? 36 : 14;
    this.cleaners = this.cleaners.filter((id) => this.people.alive[id] && this.people.role[id] === ROLE.cleaner);
    while (this.cleaners.length < want) {
      const start = this.rng.pick(this.shops);
      if (!start) break;
      const id = this.people.add(ROLE.cleaner, start.floor, start.x, start.y, 1.1, UNIFORM[ROLE.cleaner], this.rng.int(0x7fffffff), 1);
      if (id < 0) break;
      this.people.flags[id] = KIND.staff;
      this.cleaners.push(id);
      this.roam(id);
    }
  }

  private roam(person: number): void {
    const floor = this.people.floor[person];
    // Somewhere in the same concourse: within a few hundred metres, and reachable on foot.
    const x = this.people.x[person];
    const y = this.people.y[person];
    const cell = this.plan.grids[floor].cellAt(x, y);
    const options = this.shops.filter((s) => s.floor === floor && Math.hypot(s.x - x, s.y - y) < 350 && (cell < 0 || this.plan.field(s)[cell] !== 0xffff));
    if (!options.length) {
      this.people.setScript(person, [STEP.leave, 0]);
      return;
    }
    const to = this.rng.pick(options);
    this.people.setScript(person, [STEP.walk, this.field(to), STEP.wait, Math.round(this.rng.range(40, 200)), STEP.notify, EVENT.roam]);
  }

  // ---- what the panel and the tests read ---------------------------------------------------------

  /** Everyone is somewhere: created = boarded + missed + still here, for departures and arrivals. */
  audit(): { departingHere: number; arrivingHere: number; staffHere: number } {
    let departingHere = 0;
    let arrivingHere = 0;
    let staffHere = 0;
    const people = this.people;
    for (let id = 0; id < people.high; id += 1) {
      if (!people.alive[id]) continue;
      const kind = people.flags[id] & KIND_MASK;
      const missed = (people.flags[id] & MISSED) !== 0;
      if (kind === KIND.departing && !missed) departingHere += people.size[id];
      else if (kind === KIND.arriving) arrivingHere += people.size[id];
      else if (kind === KIND.staff) staffHere += 1;
    }
    return { departingHere, arrivingHere, staffHere };
  }

  /** Bags on the belts of each claim hall now: delivered and not yet picked up. */
  bagsOnBelt(claim: Place): number {
    let n = 0;
    const people = this.people;
    for (let id = 0; id < people.high; id += 1) {
      if (!people.alive[id] || this.claimAt[id] !== claim.id || (people.flags[id] & KIND_MASK) !== KIND.arriving) continue;
      if (this.bagReady[id] <= this.now && !this.lostBag[id]) n += this.bags[id];
    }
    return n;
  }

  /** A number that changes if anything about the people does; for the determinism test. */
  checksum(): number {
    let h = 2166136261;
    const people = this.people;
    for (let id = 0; id < people.high; id += 1) {
      if (!people.alive[id]) continue;
      h ^= (id * 31 + Math.round(people.x[id] * 4) * 7 + Math.round(people.y[id] * 4)) | 0;
      h = Math.imul(h, 16777619);
    }
    return (h ^ this.stats.departing.boarded ^ (this.stats.arriving.created << 8)) >>> 0;
  }

  /** Walkers on each floor. */
  get count(): number {
    return this.people.count;
  }

  /** The layout, for those drawing the terminals. */
  get map(): Layout {
    return this.layout;
  }
}
