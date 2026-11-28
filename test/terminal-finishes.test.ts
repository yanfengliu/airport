import { expect, it } from 'vitest';
import { MeshBuilder, rgb } from '../src/render/builder.ts';
import { GATE_SIGN_MODEL, gateSigns } from '../src/render/static/gate-signs.ts';
import { buildingFinishes, finishFor, panelledWall } from '../src/render/static/terminal-finishes.ts';
import { Sim } from '../src/sim/sim.ts';
import { InnerWalls, withinAny } from '../src/sim/terminal/fittings.ts';
import { FLOOR, FLOOR_HEIGHT } from '../src/sim/terminal/plan.ts';
import { readFileSync } from 'node:fs';
import { loadLayoutFromDisk, repoRoot } from './helpers/layout.ts';

const layout = loadLayoutFromDisk();

it('assigns mapped public gate areas their own building finishes', () => {
  const locate = buildingFinishes(layout.terminals.buildings);
  for (const [gate, name] of [['B17', 'Harvey Milk Terminal 1'], ['D9', 'Terminal 2'], ['G8', 'International Boarding Area G']]) {
    const door = layout.airfield.stands.find((s) => s.id === gate)!;
    const angle = door.heading;
    // From the jet bridge's terminal end into the building.
    const p = door.door!;
    const nearest = [1, 4, 7, 10].map((d) => locate(p[0] + Math.cos(angle) * d, p[1] + Math.sin(angle) * d));
    expect(nearest).toContain(finishFor(name));
  }
  expect(finishFor('Harvey Milk Terminal 1').slab).not.toEqual(finishFor('Terminal 2').slab);
  expect(finishFor('International Boarding Area G').wall).not.toEqual(finishFor('Harvey Milk Terminal 1').wall);
});

it('keeps timber and limestone panel joints within the existing wall envelope', () => {
  for (const name of ['Harvey Milk Terminal 1', 'International Boarding Area G']) {
    const b = new MeshBuilder();
    panelledWall(b, 0, 0, 5, 0, 2.5, 3, 0.2, finishFor(name), rgb(0x404040));
    const mesh = b.build();
    const box = mesh.boundingBox!;
    expect(box.min.x).toBeCloseTo(0, 5);
    expect(box.max.x).toBeCloseTo(5, 5);
    expect(box.min.y).toBeCloseTo(2.5, 5);
    expect(box.max.y).toBeCloseTo(3, 5);
    expect(box.max.z - box.min.z).toBeCloseTo(0.2, 5);
    expect(b.triangleCount).toBeGreaterThan(12);
    mesh.dispose();
  }
});

it('hangs gate identifiers over their mapped boarding lines with room for people below', () => {
  const terminals = new Sim(layout, { seed: 3, startTime: 8 * 3600, people: true }).terminals!;
  const signs = gateSigns(terminals);
  const index = JSON.parse(readFileSync(`${repoRoot}/public/models/index.json`, 'utf8')) as { models: { id: string; box: number[] }[] };
  const model = index.models.find((m) => m.id === GATE_SIGN_MODEL)!;
  const walls = new InnerWalls(layout.terminals.walls ?? [], terminals.plan.closed);
  const indoors = withinAny(layout.terminals.buildings.map((building) => building.poly));
  expect(model.box[1]).toBeGreaterThan(2.4);
  expect(new Set(signs.map((s) => s.label))).toEqual(new Set(terminals.plan.holdroom.keys()));
  expect(new Set(signs.flatMap((s) => s.podium ? [s.podium] : []))).toEqual(new Set(terminals.fittings.items.filter((f) => f.kind === 'podium')));
  for (const s of signs) {
    const gate = terminals.plan.holdroom.get(s.label)!;
    const queue = terminals.queues.get(gate.id)!.shape;
    expect(Math.hypot(s.x - queue.x, s.y - queue.y)).toBeLessThanOrEqual(queue.length / 2 + 0.01);
    expect(s.h).toBe(FLOOR_HEIGHT[FLOOR.airside]);
    expect(indoors(s.x, s.y)).toBe(true);
    expect(walls.across(FLOOR.airside, s.x, s.y, s.facing + Math.PI / 2, model.box[3] / 2, model.box[5] / 2)).toBe(false);
  }
});
