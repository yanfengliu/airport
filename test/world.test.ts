// What the static world draws of the map where a model of our own stands in for it. The control
// tower is our model of SFO's; the map has its shaft and cab too, standing on a terminal's roof,
// and until 2026-11-27 they were drawn over the model as a part of that terminal, a plain grey
// cylinder 60 m tall hiding the tower inside it, which no test saw. Bound: no mapped building that
// is drawn, on its own or above a terminal's roof, rises within reach of the model's widest part,
// and the tower is drawn with the model, its cab glass the part that glows at night.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildTower } from '../src/render/static/landmarks.ts';
import { visibleRuns } from '../src/render/static/rail.ts';
import { mappedBuildings } from '../src/render/world.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';
import { loadModelsFromDisk } from './helpers/models.ts';

const layout = loadLayoutFromDisk();

/** The nearest a polygon's edges come to a point, metres; 0 inside. */
function reach(outer: readonly number[], x: number, y: number): number {
  let inside = false;
  let least = Infinity;
  for (let i = 0, j = outer.length - 2; i < outer.length; j = i, i += 2) {
    const [ax, ay, bx, by] = [outer[j], outer[j + 1], outer[i], outer[i + 1]];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
    least = Math.min(least, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return inside ? 0 : least;
}

describe('the control tower', () => {
  const models = loadModelsFromDisk(['sfo-control-tower']);
  const model = models.get('sfo-control-tower')!;
  const [x, y] = layout.airfield.tower;

  it('has no mapped building drawn through it', () => {
    const { own, aboveRoofs } = mappedBuildings(layout);
    expect(own.length).toBeGreaterThan(500);
    expect(aboveRoofs.length).toBeGreaterThan(0);
    // The model's widest part, its cab, from its box; anything taller than the terminals' roofs
    // reaching inside that would show through it.
    const widest = model.info.box[3] / 2;
    const roofs = Math.max(...layout.terminals.buildings.map((t) => t.height));
    const through = [...own, ...aboveRoofs].filter((b) => b.height > roofs + 1 && reach(b.poly.outer, x, y) < widest + 1);
    expect(through.map((b) => `${b.kind} ${b.height} m`)).toEqual([]);
  });

  it('is drawn with our model, its cab glass the part that glows', () => {
    const tower = buildTower(x, y, models);
    const meshes = tower.group.children as THREE.Mesh[];
    expect(meshes.length).toBe(1);
    expect(meshes[0].geometry).toBe(model.geometry);
    expect(meshes[0].material).toBe(tower.glass);
    expect(model.info.parts?.indexOf('glass')).toBeGreaterThanOrEqual(0);
    expect(tower.group.position.x).toBe(x);
    expect(tower.group.position.z).toBe(-y);
  });
});

describe('the railways', () => {
  const layout = loadLayoutFromDisk();

  it('end every run of track that goes into the ground at a tunnel mouth, facing into it', () => {
    let mouths = 0;
    for (const line of layout.rail.lines) {
      // Where the line crosses into the ground or out of it, going along it.
      let crossings = 0;
      for (let i = 5; i < line.pts.length; i += 3) if (line.pts[i - 3] < -0.4 !== line.pts[i] < -0.4) crossings += 1;
      const runs = visibleRuns(line.pts);
      const portals = runs.flatMap((r) => r.portals);
      expect(portals.length, `${line.kind}: a mouth where it goes into the ground`).toBe(crossings);
      for (const run of runs) {
        for (const p of run.portals) {
          // At an end of the run, the way into the tunnel pointing away from the run.
          const n = run.pts.length;
          const atStart = Math.hypot(p.x - run.pts[0], p.y - run.pts[1]) < 0.01;
          expect(atStart || Math.hypot(p.x - run.pts[n - 3], p.y - run.pts[n - 2]) < 0.01, `${line.kind}: its mouth at an end of the run`).toBe(true);
          const [x, y] = atStart ? [run.pts[3], run.pts[4]] : [run.pts[n - 6], run.pts[n - 5]];
          expect((p.x - x) * p.ux + (p.y - y) * p.uy, `${line.kind}: facing into the tunnel`).toBeGreaterThan(0);
        }
      }
      mouths += portals.length;
    }
    // BART goes under the airport.
    expect(mouths).toBeGreaterThan(0);
  });
});
