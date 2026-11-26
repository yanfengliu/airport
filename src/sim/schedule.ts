// The daily flight schedule: a repeating pattern of aircraft visits, each an arrival, a stay at a
// stand and a departure. It is synthetic, shaped like SFO's day: the airline mix, the banks of
// long-haul flights, overnight parking and a first wave of departures in the morning.

import type { Stand } from '../shared/layout.ts';
import { AIRCRAFT, AIRLINES, BANKS, DESTINATIONS, LONG_HAUL_KM, type Airline, type Destination } from './fleet.ts';
import type { Rng } from './rng.ts';

export const DAY = 86_400;

export interface Rotation {
  id: number;
  airline: string;
  type: string;
  tail: string;
  /** Flight numbers such as "UA 512". */
  arrFlight: string;
  depFlight: string;
  /** Airport codes of the origin and the destination. */
  from: string;
  to: string;
  /** Scheduled arrival at the stand, seconds after midnight. */
  arr: number;
  /** Scheduled departure from the stand; more than a day when the aircraft stays overnight. */
  dep: number;
  paxIn: number;
  paxOut: number;
  /** Stand planned for the visit. */
  stand: string;
  /** Arriving passengers must clear customs and immigration here. */
  customs: boolean;
  internationalOut: boolean;
}

export interface ScheduleOptions {
  /** Aircraft visits per day; each is one arrival and one departure. */
  visits: number;
  /** Stands that cannot be occupied at the same time as a given stand. */
  conflicts?: ReadonlyMap<string, readonly string[]>;
}

/** Places whose passengers are cleared by US border officers before they board. */
const PRECLEARED = new Set(['YVR', 'YYC', 'YYZ', 'YUL', 'DUB']);
const HOUR = 3600;

function sampleWindow(rng: Rng, windows: [number, number, number][]): number {
  const [start, end] = rng.weighted(windows, (w) => w[2] * (w[1] - w[0]));
  return rng.range(start, end) * HOUR;
}

function inWindow(seconds: number, windows: [number, number, number][], slack: number): boolean {
  const hour = (seconds % DAY) / HOUR;
  return windows.some(([start, end]) => (hour >= start - slack && hour <= end + slack) || (hour + 24 >= start - slack && hour + 24 <= end + slack));
}

/** The first moment at or after `earliest` that falls inside one of the windows. */
function nextInWindow(earliest: number, windows: [number, number, number][], rng: Rng): number {
  let best = Infinity;
  for (const [start, end] of windows) {
    for (const dayShift of [0, 1, 2]) {
      const from = start * HOUR + dayShift * DAY;
      const to = end * HOUR + dayShift * DAY;
      if (to < earliest) continue;
      const lower = Math.max(from, earliest);
      const candidate = lower + rng.range(0, Math.min(to - lower, 50 * 60));
      if (candidate < best) best = candidate;
    }
  }
  return best;
}

function chooseDestination(rng: Rng, airline: Airline): Destination {
  // Short routes fly more often than long ones.
  return DESTINATIONS[rng.weighted(airline.destinations, (code) => 1 / Math.sqrt(DESTINATIONS[code].km + 250))];
}

function chooseType(rng: Rng, airline: Airline, km: number): string {
  if (km >= LONG_HAUL_KM) return rng.weighted(airline.longHaul, (t) => t[1])[0];
  const fits = airline.fleet.filter(([id]) => {
    const body = AIRCRAFT[id].body;
    if (body === 'regional') return km <= 1900;
    if (body === 'wide' || body === 'super') return km >= 3000;
    return true;
  });
  return rng.weighted(fits.length ? fits : airline.fleet, (t) => t[1])[0];
}

/** True when two spans of time on the daily clock overlap; either may run past midnight. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  for (const shift of [-DAY, 0, DAY]) {
    if (aStart < bEnd + shift && bStart + shift < aEnd) return true;
  }
  return false;
}

interface StandBook {
  stand: Stand;
  spans: [number, number][];
}

function assignStands(rng: Rng, rotations: Rotation[], stands: readonly Stand[], conflicts: ReadonlyMap<string, readonly string[]>): void {
  const books: StandBook[] = stands.map((stand) => ({ stand, spans: [] }));
  const bookOf = new Map(books.map((b) => [b.stand.id, b]));
  const byArea = new Map<string, StandBook[]>();
  for (const b of books) (byArea.get(b.stand.area) ?? byArea.set(b.stand.area, []).get(b.stand.area)!).push(b);
  const before = 12 * 60;
  const after = 18 * 60;
  const empty = (b: StandBook, r: Rotation): boolean => b.spans.every(([s, e]) => !overlaps(r.arr - before, r.dep + after, s, e));
  // A stand is free when it is empty and so is every stand that shares its line.
  const free = (b: StandBook, r: Rotation): boolean => empty(b, r) && (conflicts.get(b.stand.id) ?? []).every((id) => !bookOf.has(id) || empty(bookOf.get(id)!, r));

  // Wide aircraft first within each hour, since few stands take them.
  const order = [...rotations].sort((p, q) => Math.floor(p.arr / HOUR) - Math.floor(q.arr / HOUR) || AIRCRAFT[q.type].span - AIRCRAFT[p.type].span || p.id - q.id);
  for (const r of order) {
    const airline = AIRLINES.find((a) => a.code === r.airline)!;
    const span = AIRCRAFT[r.type].span;
    const international = r.customs || r.internationalOut;
    const preferred = international ? airline.internationalAreas : airline.areas;
    const fallback = r.customs ? ['G', 'A'] : ['B', 'D', 'C', 'E', 'F', 'A', 'G'];
    const tiers: string[][] = [preferred.slice(0, 1), preferred.slice(1), fallback.filter((a) => !preferred.includes(a)), ['remote']];
    let chosen: StandBook | null = null;
    for (const tier of tiers) {
      const candidates = tier.flatMap((area) => byArea.get(area) ?? []).filter((b) => b.stand.span + 0.5 >= span && (b.stand.contact || tier[0] === 'remote') && free(b, r));
      if (!candidates.length) continue;
      // The tightest fit, so large stands stay free for large aircraft.
      candidates.sort((p, q) => p.stand.span - q.stand.span || p.spans.length - q.spans.length || p.stand.id.localeCompare(q.stand.id));
      const tight = candidates.filter((c) => c.stand.span <= candidates[0].stand.span + 4);
      chosen = tight[rng.int(tight.length)];
      break;
    }
    if (!chosen) {
      // Nothing is free: take the least used stand that fits and accept a late gate.
      const fits = books.filter((b) => b.stand.span + 0.5 >= span).sort((p, q) => p.spans.length - q.spans.length);
      chosen = fits[0] ?? books[0];
    }
    chosen.spans.push([r.arr - before, r.dep + after]);
    r.stand = chosen.stand.id;
  }
}

/** Departures the runways can take in a quarter of an hour, in all and on the long runways. */
const QUARTER = 900;
const DEPARTURES_PER_QUARTER = 11;
const LONG_RUNWAY_DEPARTURES_PER_QUARTER = 3;

/**
 * Fit the departures to what the runways can take, as a coordinated airport's schedule is: one
 * that would overfill its quarter hour goes in the next with room, at the same minute past the
 * quarter. The aircraft that need the long runways have a smaller share, since each of them
 * needs a gap in the landings. Nothing is dropped, and nothing leaves earlier than planned.
 */
function coordinateDepartures(rotations: Rotation[]): void {
  const quarters = DAY / QUARTER;
  const all = new Array<number>(quarters).fill(0);
  const long = new Array<number>(quarters).fill(0);
  for (const r of [...rotations].sort((a, b) => a.dep - b.dep || a.id - b.id)) {
    const body = AIRCRAFT[r.type].body;
    const needsLength = body === 'wide' || body === 'super';
    let q = Math.floor(r.dep / QUARTER);
    // Twelve quarters at most: three hours late is as far as a flight is put back.
    for (let shift = 0; shift < 12; shift += 1) {
      const k = q % quarters;
      if (all[k] < DEPARTURES_PER_QUARTER && (!needsLength || long[k] < LONG_RUNWAY_DEPARTURES_PER_QUARTER)) break;
      q += 1;
    }
    r.dep = Math.max(r.dep, q * QUARTER + (r.dep % QUARTER));
    all[q % quarters] += 1;
    if (needsLength) long[q % quarters] += 1;
  }
}

export function buildSchedule(rng: Rng, stands: readonly Stand[], options: ScheduleOptions): Rotation[] {
  const rotations: Rotation[] = [];
  const usedNumbers = new Set<string>();
  const flightNumber = (airline: Airline, express: boolean, longHaul: boolean): string => {
    for (;;) {
      const n = express ? 5000 + rng.int(900) : longHaul ? 1 + rng.int(199) : airline.share > 0.05 ? 200 + rng.int(2400) : 200 + rng.int(1800);
      const text = `${airline.code} ${n}`;
      if (!usedNumbers.has(text)) {
        usedNumbers.add(text);
        return text;
      }
    }
  };

  for (const airline of AIRLINES) {
    const count = Math.max(1, Math.round(airline.share * options.visits));
    const foreign = airline.internationalAreas[0] === airline.areas[0] && DESTINATIONS[airline.destinations[0]].international;
    for (let i = 0; i < count; i += 1) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const to = chooseDestination(rng, airline);
        // A foreign carrier's aircraft goes back where it came from; a home carrier's goes anywhere.
        const from = foreign || rng.chance(0.35) ? to : chooseDestination(rng, airline);
        const km = Math.max(to.km, from.km);
        const type = AIRCRAFT[chooseType(rng, airline, km)];
        const arr = sampleWindow(rng, BANKS[from.region].arrivals) % DAY;
        const minimum = arr + type.turn[0] * 60;
        const longStay = type.body === 'wide' || type.body === 'super';
        let dep = arr + (type.turn[1] + rng.exponential(longStay ? 35 : 12)) * 60;
        if (!inWindow(dep, BANKS[to.region].departures, 0.2)) dep = nextInWindow(minimum, BANKS[to.region].departures, rng);
        const ground = dep - arr;
        // Too long on the ground would hold a gate all day; an overnight stay is fine.
        const overnight = arr > 19.5 * HOUR && dep > DAY + 5 * HOUR;
        if (ground > (longStay ? 7 : 3.6) * HOUR && !overnight) continue;
        if (ground > 12.5 * HOUR) continue;
        const express = type.body === 'regional';
        const longHaul = km >= LONG_HAUL_KM;
        const load = (): number => Math.round(type.seats * rng.bounded(0.86, 0.08, 0.55, 0.99));
        rotations.push({
          id: rotations.length,
          airline: airline.code,
          type: type.id,
          tail: '',
          arrFlight: flightNumber(airline, express, longHaul),
          depFlight: flightNumber(airline, express, longHaul),
          from: from.code,
          to: to.code,
          arr: Math.round(arr / 60) * 60,
          dep: Math.round(dep / 300) * 300,
          paxIn: load(),
          paxOut: load(),
          stand: '',
          customs: from.international && !PRECLEARED.has(from.code),
          internationalOut: to.international,
        });
        break;
      }
    }
  }

  coordinateDepartures(rotations);
  rotations.sort((a, b) => a.arr - b.arr || a.id - b.id);
  rotations.forEach((r, index) => {
    r.id = index;
    const serial = 100 + ((index * 37) % 900);
    r.tail = AIRLINES.find((a) => a.code === r.airline)!.share > 0.004 && !DESTINATIONS[r.to].international ? `N${serial}${r.airline}` : `${r.airline}-${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + ((index * 7) % 26))}${String.fromCharCode(65 + ((index * 11) % 26))}`;
  });
  assignStands(rng, rotations, stands, options.conflicts ?? new Map());
  return rotations;
}

/** Hour-by-hour counts, for checking the shape of the day. */
export function hourlyProfile(rotations: readonly Rotation[]): { arrivals: number[]; departures: number[] } {
  const arrivals = new Array<number>(24).fill(0);
  const departures = new Array<number>(24).fill(0);
  for (const r of rotations) {
    arrivals[Math.floor(r.arr / HOUR) % 24] += 1;
    departures[Math.floor((r.dep % DAY) / HOUR) % 24] += 1;
  }
  return { arrivals, departures };
}
