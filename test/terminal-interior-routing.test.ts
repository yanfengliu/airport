import { expect, it } from 'vitest';
import { courtyard3 } from '../src/shared/courtyard3.ts';
import { terminalGlazing, type Wall } from '../src/render/static/gallery-walls.ts';
import { Sim } from '../src/sim/sim.ts';
import { ServiceQueue } from '../src/sim/terminal/queue.ts';
import { ACT, People, ROLE, STEP } from '../src/sim/terminal/people.ts';
import { FLOOR } from '../src/sim/terminal/plan.ts';
import { passengerMaps } from '../src/ui/terminal-map-data.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();
const terminals = new Sim(layout, { seed: 7, startTime: 0, people: true }).terminals!;
const plan = terminals.plan;

function crosses(a: Wall, b: Wall): boolean {
  const dx = a[2] - a[0], dy = a[3] - a[1], ex = b[2] - b[0], ey = b[3] - b[1];
  const det = dx * ey - dy * ex;
  if (Math.abs(det) < 1e-8) return false;
  const x = b[0] - a[0], y = b[1] - a[1];
  const t = (x * ey - y * ex) / det, u = (x * dy - y * dx) / det;
  return t > 0 && t <= 1 && u >= 0 && u <= 1;
}

it('walks the furnished D1–E4 route, in both directions, through open sections in the glazing and its frames', () => {
  const buildings = layout.terminals.buildings.map((b) => b.poly);
  const gallery = courtyard3(layout.terminals)!;
  const floorAt = (x: number, y: number) => [FLOOR.airside, FLOOR.landside].some((f) => plan.grids[f].cellAt(x, y) >= 0);
  const walls = terminalGlazing(buildings, gallery, floorAt);
  expect(walls.length).toBeGreaterThan(200);
  for (const [from, to] of [['D1', 'E4'], ['E4', 'D1']]) {
    const start = plan.holdroom.get(from)!, end = plan.holdroom.get(to)!;
    const people = new People(1, plan.grids, () => 0);
    const person = people.add(ROLE.passenger, FLOOR.airside, start.x, start.y, 1.5, 0, 0);
    const field = people.addField(FLOOR.airside, plan.field(end), end.x, end.y);
    people.setScript(person, [STEP.walk, field, STEP.leave, 0]);
    const hits = new Set<Wall>();
    for (let t = 0; t < 1000 && people.alive[person]; t += 0.5) {
      const x = people.x[person], y = people.y[person];
      people.step(t, 0.5, 0, 1);
      const move: Wall = [x, y, people.x[person], people.y[person]];
      for (const wall of walls) if (crosses(move, wall)) hits.add(wall);
    }
    expect(people.alive[person]).toBe(0);
    expect(Math.hypot(people.x[person] - end.x, people.y[person] - end.y)).toBeLessThan(5);
    expect([...hits], from + ' to ' + to).toEqual([]);
  }
});

it('puts the two arrivals-level restroom listings, their floor overlays and their walled rooms on the same level', () => {
  const restrooms = passengerMaps(layout, plan).flatMap((m) => m.destinations.filter((p) => p.group === 'Restrooms'));
  const lower = restrooms.filter((r) => r.floor === 'arrivals');
  expect(restrooms.length).toBeGreaterThanOrEqual(39);
  expect(lower.map((r) => r.name)).toEqual(['Restrooms · near Gate B2', 'Restrooms · near Gate E2']);
  for (const place of restrooms) {
    const room = layout.terminals.areas.findIndex((a) => a.poly === place.room);
    expect(plan.mappedFloors.rooms[room]).toBe(place.floor);
    const fitting = terminals.fittings.rooms.find((r) => r.room === room);
    if (place.floor === 'arrivals') expect(fitting?.floor).toBe(FLOOR.arrivals);
    if (fitting) expect(fitting.floor === FLOOR.arrivals ? 'arrivals' : 'departures').toBe(place.floor);
  }
});

it('lets a customer called from either side cross behind the lane mouths before turning in', () => {
  for (const angle of [0, Math.PI / 3]) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const target = [3 * c, 3 * s];
    const queue = new ServiceQueue({ x: -4 * c, y: -4 * s, heading: angle, length: 4, width: 4 }, [{ x: target[0], y: target[1], approachX: 0, approachY: 0 }]);
    queue.setOpen(1);
    for (const side of [-1, 1]) {
      const people = new People(1, plan.grids, () => 0);
      const id = people.add(ROLE.passenger, FLOOR.landside, 1.5 * c - 9 * s * side, 1.5 * s + 9 * c * side, 1.3, 0, 0);
      people.setScript(id, [STEP.queue, people.addQueue(queue)]);
      people.step(0, 0, 0, 1);
      people.stepQueues(0);
      expect(people.act[id]).toBe(ACT.served);
      for (let time = 0; time < 15; time += 0.25) {
        people.step(time, 0.25, 0, 1);
        const along = people.x[id] * c + people.y[id] * s;
        const across = Math.abs(-people.x[id] * s + people.y[id] * c);
        if (across > 0.25 && across < 8.75) expect(along).toBeLessThan(0.05);
      }
      expect(Math.hypot(people.x[id] - target[0], people.y[id] - target[1])).toBeLessThan(0.05);
      queue.leave(id);
    }
  }
});
