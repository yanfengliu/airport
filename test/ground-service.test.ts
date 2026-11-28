import { describe, expect, it } from 'vitest';
import { opsSnapshot } from '../src/app/ops-source.ts';
import { FlightBook } from '../src/sim/airside/flights.ts';
import { GroundService, SERVICE_KINDS } from '../src/sim/airside/ground-service.ts';
import { CONFIG } from '../src/sim/config.ts';
import { Rng } from '../src/sim/rng.ts';
import type { Rotation } from '../src/sim/schedule.ts';
import { boardingGroupDelay } from '../src/sim/terminal/terminals.ts';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const cfg = CONFIG.groundService;
const base: Rotation = { id: 0, airline: 'UA', type: 'B738', tail: 'N123UA', arrFlight: 'UA 1', depFlight: 'UA 2',
  from: 'LAX', to: 'SEA', arr: 0, dep: 3600, paxIn: 130, paxOut: 145, stand: 'E2', customs: false, internationalOut: false };

function visits() {
  const book = new FlightBook([base, { ...base, id: 1, to: 'JFK', stand: 'E4' }]);
  book.extendTo(0);
  const parked = [...book.visits.values()].filter((v) => v.sta === 0);
  for (const v of parked) v.onBlockAt = 0;
  return parked;
}

describe('ground handling', () => {
  it('reserves finite crews in call order, pumps the route uplift once, and waits for an empty cabin', () => {
    const parked = visits().reverse();
    const [second, first] = parked;
    const depot = new GroundService(new Rng(7), { fuel: 1, cleaning: 1, inspection: 1 });
    depot.step(parked, 0);
    depot.step(parked, cfg.fuelCallAfter);
    const a = first.service!;
    const b = second.service!;
    expect(a.jobs.fuel.status).toBe('working');
    expect(b.jobs.fuel.status).toBe('waiting');
    expect(b.jobs.fuel.startsAt).toBe(a.jobs.fuel.endsAt + cfg.transferSeconds.fuel);
    expect(b.fuelKg).toBeGreaterThan(a.fuelKg);
    depot.step(parked, a.jobs.fuel.startsAt + cfg.fuelSetup + 1);
    expect(a.fuelDeliveredKg).toBe(cfg.pumpKgPerSecond.narrow);
    expect(b.fuelDeliveredKg).toBe(0);
    first.deplaned = first.rotation.paxIn;
    depot.step(parked, 500);
    expect(a.jobs.cleaning.status).toBe('working');
    expect(b.jobs.cleaning.crew).toBeNull();
    second.deplaned = second.rotation.paxIn;
    depot.step(parked, 505);
    expect(b.jobs.cleaning.startsAt).toBe(a.jobs.cleaning.endsAt + cfg.transferSeconds.cleaning);
    for (const s of [a, b]) expect(s.jobs.inspection.crew).toBe(0);
    depot.step(parked, 7200);
    expect([a.fuelDeliveredKg, b.fuelDeliveredKg]).toEqual([a.fuelKg, b.fuelKg]);
    for (const s of [a, b]) for (const kind of SERVICE_KINDS) expect(s.jobs[kind].status).toBe('done');
    depot.step(parked, 8000);
    expect(a.fuelDeliveredKg).toBe(a.fuelKg);
  });

  it('keeps an unstaffed fuel call queued with zero uplift while the other teams work', () => {
    const parked = visits();
    const depot = new GroundService(new Rng(7), { fuel: 0, inspection: 1, cleaning: 1 });
    for (const v of parked) v.deplaned = v.rotation.paxIn;
    depot.step(parked, 3600, true);
    for (const v of parked) {
      expect(v.service!.jobs.fuel).toMatchObject({ status: 'waiting', crew: null, startsAt: Infinity, endsAt: Infinity });
      expect(v.service!.fuelDeliveredKg).toBe(0);
      expect(v.service!.jobs.inspection.status).toBe('done');
    }
  });

  it('calls even the last group within the available window when a widebody cabin is released late', () => {
    const [v] = visits();
    v.rotation = { ...v.rotation, type: 'B789', paxOut: 240 };
    const close = v.etd - CONFIG.turnaround.doorsClose * 60;
    const rng = new Rng(7);
    const delays = Array.from({ length: 240 }, () => boardingGroupDelay(v, close - 701, rng));
    expect(Math.max(...delays)).toBeLessThan(351);
    expect(new Set(delays).size).toBeGreaterThan(6);
    expect(boardingGroupDelay(v, close + 1, rng)).toBe(0);
  });

  it('reconstructs elapsed stand work on a mid-day start and replays the same assignments', () => {
    const build = () => {
      const v = visits();
      v[1].onBlockAt = 3590;
      new GroundService(new Rng(7)).step(v, 3600, true);
      return v.map((r) => r.service!);
    };
    const [early, recent] = build();
    expect([early, recent]).toEqual(build());
    expect(SERVICE_KINDS.map((k) => early.jobs[k].status)).toEqual(['done', 'done', 'done']);
    expect(SERVICE_KINDS.map((k) => recent.jobs[k].status)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  it('opens boarding after cleaning and pushes only serviced aircraft in the live flight schedule', () => {
    const sim = new Sim(loadLayoutFromDisk(), { seed: 7, startTime: 8 * 3600 });
    let boarded = false;
    const pushed = new Set<number>();
    for (let i = 0; i < 720; i++) {
      sim.run(5);
      for (const a of sim.airside.aircraft) {
        const v = a.visit;
        if (v.boardingOpen && v.service?.jobs.cleaning.status !== 'done') throw new Error('Boarding an uncleaned cabin');
        if (v.boardingOpen) boarded = true;
        if (a.phase === 'pushback' && !pushed.has(v.id)) {
          expect(v.doorsClosed).toBe(true);
          const s = v.service!;
          for (const kind of SERVICE_KINDS) expect(s.jobs[kind].endsAt).toBeLessThanOrEqual(v.offBlockAt);
          expect(s.fuelDeliveredKg).toBe(s.fuelKg);
          pushed.add(v.id);
        }
      }
    }
    expect(boarded).toBe(true);
    expect(pushed.size).toBeGreaterThan(5);
    const ops = opsSnapshot(sim);
    for (const kind of SERVICE_KINDS) {
      const busy = sim.airside.aircraft.filter((a) => a.phase === 'parked' && a.visit.service?.jobs[kind].status === 'working').length;
      expect(ops.crews[kind]).toBe(busy);
      expect(busy).toBeLessThanOrEqual(cfg.crews[kind]);
    }
  });
});
