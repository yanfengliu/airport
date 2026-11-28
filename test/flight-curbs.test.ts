// Real road links and addressed curbs; a controlled flight can be held off its stand or moved
// from one terminal to another without changing freeway demand.
import { expect, it } from 'vitest';
import { FlightBook } from '../src/sim/airside/flights.ts';
import { CONFIG } from '../src/sim/config.ts';
import { AIRLINE_BY_CODE } from '../src/sim/fleet.ts';
import { Rng } from '../src/sim/rng.ts';
import { PURPOSE } from '../src/sim/roads/airport.ts';
import { FlightCurbDemand } from '../src/sim/roads/flight-curbs.ts';
import { RoadSim } from '../src/sim/roads/roads.ts';
import type { Rotation } from '../src/sim/schedule.ts';
import { Sim } from '../src/sim/sim.ts';
import { arrivalStart } from '../src/sim/terminal/passenger-halls.ts';
import { buildTerminalPlan } from '../src/sim/terminal/plan.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const plan = buildTerminalPlan(layout);
const hour = 3600;
const base: Rotation = {
  id: 0, airline: 'UA', type: 'B738', tail: 'N100UA', arrFlight: 'UA 10', depFlight: 'UA 11',
  from: 'SEA', to: 'LAX', arr: 23 * hour, dep: 26 * hour, paxIn: 100, paxOut: 150,
  stand: 'B2', customs: false, internationalOut: false,
};

function scenario() {
  const book = new FlightBook([base]);
  book.extendTo(0);
  const visit = [...book.visits.values()].find((v) => v.sta === base.arr)!;
  book.visits.clear();
  book.visits.set(visit.id, visit);
  const road = new RoadSim(layout.roads, layout.land.bounds, [-975, -280], new Rng(42));
  const demand = new FlightCurbDemand(book, layout.airfield.stands, road.net, road.airport.departuresCurbs, road.airport.arrivalsCurbs, plan);
  return { book, visit, road, demand };
}

it('preserves each flight’s represented local demand across midnight, with pickups following actual parking', () => {
  const { visit, demand } = scenario();
  visit.onBlockAt = visit.sta + hour;
  let pickUps = 0;
  let dropOffs = 0;
  let peakPickup = 0;
  let peakTime = 0;
  for (let t = visit.std - 5 * hour; t < visit.std; t += 60) {
    demand.update(t);
    const rates = demand.perHour;
    if (t < visit.onBlockAt) expect(rates.pickUp).toBe(0);
    if (rates.pickUp > peakPickup) {
      peakPickup = rates.pickUp;
      peakTime = t;
    }
    dropOffs += rates.dropOff / 60;
    pickUps += rates.pickUp / 60;
  }
  const represented = CONFIG.curbTraffic.tripsPerPassenger * (1 - AIRLINE_BY_CODE.UA.connecting);
  expect(dropOffs).toBeCloseTo(visit.rotation.paxOut * represented, 9);
  expect(pickUps).toBeCloseTo(visit.rotation.paxIn * represented, 9);
  expect(Math.abs((peakTime - visit.onBlockAt) / 60 - CONFIG.curbTraffic.domesticArrival[1])).toBeLessThanOrEqual(1);
});

it('brings international departures earlier and gives arriving parties longer to clear customs', () => {
  const { visit, demand } = scenario();
  visit.rotation = { ...base, internationalOut: true, customs: true };
  visit.onBlockAt = visit.std - 4 * hour;
  demand.update(visit.std - 3.5 * hour);
  expect(demand.perHour.dropOff).toBeGreaterThan(0);
  demand.update(visit.onBlockAt + 65 * 60);
  expect(demand.perHour.pickUp).toBeGreaterThan(0);
  visit.rotation = base;
  demand.update(visit.std - 3.5 * hour + 60);
  expect(demand.perHour.dropOff).toBe(0);
  demand.update(visit.onBlockAt + 66 * 60);
  expect(demand.perHour.pickUp).toBe(0);
});

it('dispatches vehicles to the claim hall of the changed stand and completes their lower-level stops', () => {
  const { book, visit, road } = scenario();
  visit.stand = 'F5';
  visit.onBlockAt = 8 * hour;
  visit.std = 18 * hour;
  visit.rotation = { ...base, paxIn: 350 };
  road.through.scale = 0;
  road.airport.connectFlights(book, layout.airfield.stands, plan);
  const called = new Set<number>();
  for (let t = visit.onBlockAt; t <= visit.onBlockAt + hour; t += CONFIG.dt) {
    road.step(CONFIG.dt, t, t);
    for (const v of road.traffic.vehicles) {
      if (v.purpose === PURPOSE.pickUp && v.stopLink >= 0) called.add(v.stopLink);
    }
  }
  expect(road.airport.stats.pickUps).toBeGreaterThan(10);
  expect(road.airport.stats.dropOffs).toBe(0);
  const right = plan.claim.get('F')!.domestic;
  const old = plan.claim.get('B')!.domestic;
  expect(called.size).toBeGreaterThan(0);
  for (const id of called) {
    const l = road.net.links[id];
    expect(l.name).toBe('Arrivals');
    const p = road.net.point(l, l.len / 2, 0, { x: 0, y: 0, z: 0, heading: 0 });
    expect(Math.hypot(p.x - right.x, p.y - right.y)).toBeLessThan(Math.hypot(p.x - old.x, p.y - old.y));
  }
});

it('uses the flight book on the normal simulation path while freeway traffic keeps its own demand', () => {
  const sim = new Sim(layout, { seed: 5, startTime: 8 * hour, roads: true });
  sim.step();
  expect(sim.roads!.airport.curbDemandPerHour.dropOff).toBeGreaterThan(0);
  for (const visit of sim.airside.book.visits.values()) visit.rotation = { ...visit.rotation, paxIn: 0, paxOut: 0 };
  sim.run(61);
  expect(sim.roads!.airport.curbDemandPerHour).toEqual({ dropOff: 0, pickUp: 0 });
  expect(sim.roads!.through.roads.get('US 101')!.admitted).toBeGreaterThan(0);
});

it('collects the full customs arrival at its international claim while departures keep their local share', () => {
  const { visit, demand, road } = scenario();
  visit.stand = 'F5';
  visit.rotation = { ...base, from: 'MEX', customs: true };
  visit.onBlockAt = visit.sta;
  const holdroom = plan.holdroom.get('F5')!;
  expect(arrivalStart(plan, holdroom, true).area).toBe('G');
  const claim = plan.claim.get('G')!.international;
  const links = road.airport.arrivalsCurbs;
  const distances = links.map((l) => {
    const p = road.net.point(l, l.len / 2, 0, { x: 0, y: 0, z: 0, heading: 0 });
    return Math.hypot(claim.x - p.x, claim.y - p.y);
  });
  const allowed = new Set(links.filter((_, i) => distances[i] <= Math.min(...distances) + CONFIG.curbTraffic.frontageSpread));
  const taken = new Set();
  const rng = new Rng(42);
  let pickups = 0, dropoffs = 0;
  for (let t = visit.std - 5 * hour; t <= visit.std; t += 60) {
    demand.update(t);
    if (demand.perHour.pickUp > 0) taken.add(demand.pick('pickUp', rng));
    pickups += demand.perHour.pickUp / 60;
    dropoffs += demand.perHour.dropOff / 60;
  }
  expect(pickups).toBeCloseTo(100 * CONFIG.curbTraffic.tripsPerPassenger, 9);
  expect(dropoffs).toBeCloseTo(150 * CONFIG.curbTraffic.tripsPerPassenger * (1 - AIRLINE_BY_CODE.UA.connecting), 9);
  expect(taken).toEqual(allowed);
});
