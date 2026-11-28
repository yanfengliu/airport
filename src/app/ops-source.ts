import { SERVICE_KINDS } from '../sim/airside/ground-service.ts';
// What the operations panel shows, read from the simulation: plain numbers and words, so that the
// panel itself knows nothing of how the airport works. Cheap enough to take once a second.

import { NOT_YET, TAXI_IN_NOMINAL } from '../sim/airside/flights.ts';
import { DAY } from '../sim/schedule.ts';
import type { Sim } from '../sim/sim.ts';
import { tailwindOn28 } from '../sim/weather.ts';
import type { OpsSnapshot } from '../ui/ops.ts';

const HOUR = 3600;
/** Road names the panel reports speeds for, with what it calls them. */
const ROADS: [string, (name: string) => boolean][] = [
  ['US-101', (n) => n === 'US 101'],
  ['I-380', (n) => n === 'I 380'],
  ['Airport spur', (n) => n === 'US 101 Spur' || n === 'North Access Road' || n === 'South Link Road'],
  ['Terminal loop', (n) => n === 'Departures' || n === 'Arrivals'],
];

export function opsSnapshot(sim: Sim): OpsSnapshot {
  const airside = sim.airside;
  const tower = airside.tower;
  const now = sim.time;
  // Rates over the last hour, or over as much of it as has been run, as so many an hour.
  const span = Math.max(600, Math.min(HOUR, now - sim.startTime));
  let arrivals = 0;
  let departures = 0;
  let offBlock = 0;
  let arrivalLate = 0;
  let departureLate = 0;
  let waitingToLand = 0;
  for (const v of airside.book.visits.values()) {
    if (v.landedAt > now - span && v.landedAt <= now) {
      arrivals += 1;
      arrivalLate += Math.max(0, v.landedAt - (v.sta - TAXI_IN_NOMINAL));
    }
    if (v.airborneAt > now - span && v.airborneAt <= now) departures += 1;
    if (v.offBlockAt > now - span && v.offBlockAt <= now) {
      offBlock += 1;
      departureLate += Math.max(0, v.offBlockAt - v.std);
    }
    if (v.state === 'scheduled' && v.queuedEta !== NOT_YET) waitingToLand += 1;
  }
  let approaching = 0;
  let taxiing = 0;
  let queuedForTakeoff = 0;
  const crews = { fuel: 0, inspection: 0, cleaning: 0, queued: 0 };
  const occupied = new Set<string>();
  for (const a of airside.aircraft) {
    if (a.phase === 'parked' && a.visit.service) {
      for (const kind of SERVICE_KINDS) {
        const job = a.visit.service.jobs[kind];
        if (job.status === 'working') crews[kind]++;
        if (job.status === 'waiting' && job.requestedAt <= now) crews.queued++;
      }
    }
    if (a.phase === 'approach') approaching += 1;
    else if (a.phase === 'taxiIn' || a.phase === 'taxiOut' || a.phase === 'pushback') taxiing += 1;
    if (a.phase === 'lineUp' || (a.phase === 'taxiOut' && a.holdKind.startsWith('line up'))) queuedForTakeoff += 1;
    if (a.phase === 'parked' || a.phase === 'pushback') occupied.add(a.visit.stand);
  }
  const contact = new Set(sim.layout.airfield.stands.filter((s) => s.contact).map((s) => s.id));
  const usable = [...sim.usableStands.keys()].filter((id) => contact.has(id)).length;

  const checkpoints: OpsSnapshot['checkpoints'] = [];
  let onBelts = 0;
  let people = 0;
  let bags = { inSystem: 0, onBelts: 0, mishandled: 0 };
  const t = sim.terminals;
  if (t) {
    for (const place of new Set(t.plan.checkpoint.values())) {
      const q = t.queues.get(place.id);
      if (!q) continue;
      let line = 0;
      for (const p of q.line) line += t.people.size[p] || 1;
      checkpoints.push({ id: place.id, name: place.name.replace('Checkpoint ', ''), open: q.openServers, lanes: q.servers.length, line, wait: q.recentWait, closed: t.closedCheckpoints.has(place.id) });
    }
    checkpoints.sort((a, b) => a.name.localeCompare(b.name));
    for (const claim of t.plan.claim.values()) for (const place of new Set([claim.domestic, claim.international])) onBelts += t.bagsOnBelt(place);
    const b = t.stats.bags;
    bags = { inSystem: t.bagsInSystem(), onBelts, mishandled: (b.leftBehind + b.misrouted + b.lost) / Math.max(1, b.checked + b.delivered) };
    const here = t.audit();
    people = here.departingHere + here.arrivingHere + here.staffHere;
  }

  const roads: OpsSnapshot['roads'] = [];
  let vehicles = 0;
  if (sim.roads) {
    const links = sim.roads.net.links;
    vehicles = sim.roads.traffic.vehicles.length;
    for (const [label, matches] of ROADS) {
      let n = 0;
      let sum = 0;
      for (const v of sim.roads.traffic.vehicles) {
        if (!matches(links[v.link].name)) continue;
        n += 1;
        sum += v.v;
      }
      roads.push({ name: label, mph: n ? (sum / n) * 2.237 : 0, vehicles: n });
    }
  }

  const events = [...airside.events, ...(t?.events ?? [])].sort((a, b) => b.time - a.time).slice(0, 14).map((e) => ({ time: ((e.time % DAY) + DAY) % DAY, kind: e.kind, text: e.text }));
  const w = airside.weather;
  return {
    plan: tower.plan.name,
    landing: tower.arrivalEnds,
    departing: [...tower.departureEndsFor('narrow')],
    longDepartures: [...tower.departureEndsFor('wide')],
    paired: tower.visual,
    changeover: Math.max(0, tower.notBefore - now),
    runways: [...tower.runways.keys()].sort().map((id) => ({ id, closed: tower.closed.has(id) })),
    weather: { windFrom: w.windFrom, windKnots: w.windKnots, visibility: w.visibility, ceiling: w.ceiling, tailwind28: tailwindOn28(w) },
    movements: { arrivals: (arrivals * HOUR) / span, departures: (departures * HOUR) / span, goArounds: tower.stats.goArounds, arrivalDelay: arrivals ? arrivalLate / arrivals : 0, departureDelay: offBlock ? departureLate / offBlock : 0, approaching, taxiing, waitingToLand, queuedForTakeoff },
    gates: { occupied: [...occupied].filter((id) => contact.has(id)).length, usable },
    crews,
    concessions: t?.concessionSummary() ?? null,
    curbs: sim.roads?.airport.curbDemandPerHour ?? null,
    checkpoints,
    bags,
    roads,
    vehicles,
    people,
    events,
  };
}
