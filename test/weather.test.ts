// Weather and closures drive the runways: a southeast wind turns the airport to the Southeast
// Plan, low cloud leaves one arrival stream and delays show on the board, a change of visibility
// keeps the room behind a super-heavy, and a closed runway gets no new traffic. Bound: two
// simulated hours each, airside only, and the tower's landing slots on their own; the
// hour-by-hour story of any such change is `node tools/sim/scenario.ts`.

import { describe, expect, it } from 'vitest';
import { TaxiNet } from '../src/sim/airfield/net.ts';
import type { Visit } from '../src/sim/airside/flights.ts';
import { CONFIG } from '../src/sim/config.ts';
import type { WakeClass } from '../src/sim/fleet.ts';
import { Sim } from '../src/sim/sim.ts';
import { WEATHER_PRESETS, planFor, tailwindOn28 } from '../src/sim/weather.ts';
import { SOUTHEAST_PLAN, Tower, WEST_PLAN } from '../src/sim/airside/tower.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const preset = (id: string) => WEATHER_PRESETS.find((p) => p.id === id)!.weather;
const visits = (sim: Sim): Visit[] => [...sim.airside.book.visits.values()];

describe('the wind picks the runways', () => {
  it('lands on the 28s in a west wind and turns only when the wind has clearly turned', () => {
    expect(planFor(preset('clear'), WEST_PLAN)).toBe(WEST_PLAN);
    expect(planFor(preset('storm'), WEST_PLAN)).toBe(SOUTHEAST_PLAN);
    // A light tailwind on the 28s keeps the Southeast Plan once it is in use, but does not bring it.
    const light = { windFrom: 120, windKnots: 5, visibility: 10, ceiling: 20_000 };
    expect(tailwindOn28(light)).toBeGreaterThan(3);
    expect(tailwindOn28(light)).toBeLessThan(8);
    expect(planFor(light, WEST_PLAN)).toBe(WEST_PLAN);
    expect(planFor(light, SOUTHEAST_PLAN)).toBe(SOUTHEAST_PLAN);
  });

  it('moves landings to 19L and 19R and take-offs to 10L and 10R after a southeast storm comes in', () => {
    const sim = new Sim(layout, { seed: 7, startTime: 11 * 3600 });
    sim.run(600);
    const turned = sim.time;
    sim.airside.setWeather(preset('storm'));
    sim.run(2 * 3600);
    // Once the changeover and the approaches already flying are done, nothing lands or leaves the old way.
    const settled = turned + 30 * 60;
    const landed = visits(sim).filter((v) => v.landedAt > settled);
    const left = visits(sim).filter((v) => v.offBlockAt > settled);
    expect(landed.length).toBeGreaterThan(20);
    expect(left.length).toBeGreaterThan(20);
    expect(landed.every((v) => v.arrivalRunway === '19L' || v.arrivalRunway === '19R')).toBe(true);
    expect(left.every((v) => v.departureRunway === '10L' || v.departureRunway === '10R')).toBe(true);
    expect(sim.airside.events.some((e) => e.kind === 'runways' && e.text.includes('Southeast'))).toBe(true);
    expect(sim.airside.traffic.outOfOrder).toBe(0);
  });
});

describe('low cloud', () => {
  it('lands one stream at a time, and the delays show on the arrivals board', () => {
    const sim = new Sim(layout, { seed: 7, startTime: 13.5 * 3600, weather: preset('low-cloud') });
    sim.run(2 * 3600);
    const landed = visits(sim).filter((v) => v.landedAt > 0);
    expect(landed.length).toBeGreaterThan(20);
    expect(new Set(landed.map((v) => v.arrivalRunway))).toEqual(new Set(['28R']));
    // One stream lands at most one aircraft per slot, two minutes apart.
    const times = landed.map((v) => v.landedAt).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThan(100);
    const board = sim.airside.book.arrivalsBoard(sim.time, 60);
    expect(board.some((row) => row.status === 'Delayed')).toBe(true);
  });
});

describe('a change of visibility behind a super-heavy', () => {
  type Given = { end: string; threshold: number; wake: WakeClass; beat: number };
  /**
   * Every arrival lands at least one slot after the one before it on its runway end, and two
   * after a super-heavy, in the beat that one was given in, whatever the beat has become since.
   */
  const spacingFaults = (given: Given[]): string[] => {
    const faults: string[] = [];
    for (const a of given) {
      for (const b of given) {
        if (a === b || a.end !== b.end || b.threshold < a.threshold) continue;
        const needed = a.beat * (a.wake === 'J' ? 1 + CONFIG.runway.slotsBehindSuper : 1);
        if (b.threshold - a.threshold < needed) faults.push(`${b.wake} on ${b.end} at ${b.threshold}, ${b.threshold - a.threshold} s behind the ${a.wake} at ${a.threshold}; needs ${needed}`);
      }
    }
    return faults;
  };
  const towerAndLog = () => {
    const tower = new Tower(new TaxiNet(layout.airfield), () => null);
    const given: Given[] = [];
    const assign = (earliest: number, wake: WakeClass, prefer: string | null) => {
      const slot = tower.assignSlot(earliest, wake, prefer);
      if (slot) given.push({ ...slot, wake, beat: tower.slotLength });
      return slot;
    };
    return { tower, given, assign };
  };

  it('keeps the empty slot behind a super-heavy when paired approaches resume', () => {
    // Review 1's case: a super-heavy on 28R at 12,000 s, one stream two minutes apart, then the
    // cloud lifts. The next arrival on 28R must be 240 s behind it at least; it was given 12,160.
    const { tower, given, assign } = towerAndLog();
    tower.setPaired(false);
    expect(assign(12_000, 'J', null)).toEqual({ end: '28R', threshold: 12_000 });
    tower.setPaired(true);
    for (let i = 0; i < 6; i += 1) assign(12_000, 'M', '28R');
    const on28R = given.filter((g) => g.end === '28R' && g.wake === 'M');
    expect(on28R.length).toBeGreaterThan(0);
    expect(Math.min(...on28R.map((g) => g.threshold))).toBeGreaterThanOrEqual(12_000 + 2 * CONFIG.runway.slotInstrument);
    expect(spacingFaults(given)).toEqual([]);
  });

  it('keeps it when the cloud comes down and one stream remains', () => {
    const { tower, given, assign } = towerAndLog();
    expect(assign(12_000, 'J', '28R')).toEqual({ end: '28R', threshold: 94 * CONFIG.runway.slotVisual });
    tower.setPaired(false);
    for (let i = 0; i < 4; i += 1) assign(12_000, 'M', null);
    expect(given.filter((g) => g.wake === 'M').every((g) => g.end === '28R')).toBe(true);
    expect(spacingFaults(given)).toEqual([]);
  });

  it('keeps a gap left for a departure when the beat changes', () => {
    const { tower, given, assign } = towerAndLog();
    tower.setPaired(false);
    assign(12_000, 'M', null);
    // A gap two slots on, left for a departure; then the cloud lifts and arrivals keep coming.
    tower.addHole('28R', 12_240);
    tower.setPaired(true);
    for (let i = 0; i < 6; i += 1) assign(12_000, 'M', '28R');
    const into = given.filter((g) => g.end === '28R' && g.threshold > 12_240 - CONFIG.runway.slotVisual && g.threshold < 12_240 + CONFIG.runway.slotInstrument);
    expect(into).toEqual([]);
    expect(spacingFaults(given)).toEqual([]);
  });
});

describe('a closed runway', () => {
  it('takes no new departures, and they go from its neighbour', () => {
    const sim = new Sim(layout, { seed: 7, startTime: 15 * 3600 });
    sim.airside.setRunwayClosed(sim.airside.net.runwayEnds.get('01R')!.runway.id, true);
    sim.run(2 * 3600);
    const left = visits(sim).filter((v) => v.offBlockAt > 0 && v.departureRunway.startsWith('01'));
    expect(left.length).toBeGreaterThan(20);
    expect(left.every((v) => v.departureRunway === '01L')).toBe(true);
  });
});
