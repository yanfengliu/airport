// Where the map has a hangar, a cargo building, a car park or a fuel tank of near the kit model's
// shape, the kit's model stands in for it (src/render/static/kit-buildings.ts). Bound: every such
// mapped building, as the committed layout has it: the kit's pieces fill its footprint's box and no
// more, at its mapped height, keep the model's proportions where they show (a hangar's shape, a
// shed's or a car park's width along the front, a tank round), and the mapped building is then not
// drawn as well.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CIRCULAR, KIT_BUILDINGS, RECTANGULAR, footprintBox, kitBuildings } from '../src/render/static/kit-buildings.ts';
import { mappedBuildings } from '../src/render/world.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';
import { loadModelsFromDisk } from './helpers/models.ts';

const layout = loadLayoutFromDisk();
const models = loadModelsFromDisk(Object.values(KIT_BUILDINGS).map((k) => k.id));
const boxes = new Map([...models].map(([id, m]) => [id, m.info.box]));

function area(o: readonly number[]): number {
  let a = 0;
  for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2) a += o[j] * o[i + 1] - o[i] * o[j + 1];
  return Math.abs(a / 2);
}

describe("the kit's buildings", () => {
  const { placements, replaced } = kitBuildings(layout, boxes);

  it('stand in for every mapped hangar, cargo building, car park and tank of near their shape, which are then not drawn as mapped', () => {
    expect(replaced.size).toBeGreaterThan(30);
    for (const b of layout.buildings.buildings) {
      const kit = KIT_BUILDINGS[b.kind as keyof typeof KIT_BUILDINGS];
      if (!kit || (b.minHeight ?? 0) > 0) continue;
      const fit = footprintBox(b.poly.outer);
      const shape = kit.lay === 'one' ? area(b.poly.outer) / (Math.PI * (fit.length / 2) ** 2) : area(b.poly.outer) / (fit.length * fit.width);
      const near = shape >= (kit.lay === 'one' ? CIRCULAR : RECTANGULAR);
      expect(replaced.has(b), `${b.kind} ${b.name ?? ''} at ${shape.toFixed(2)} of its shape`).toBe(near);
    }
    const { own } = mappedBuildings(layout, replaced);
    expect(own.filter((b) => replaced.has(b))).toEqual([]);
  });

  it('fills the box of each footprint and no more, at its mapped height, keeping the proportions of the model where they show', () => {
    const faults: string[] = [];
    const at = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    for (const b of replaced) {
      const fit = footprintBox(b.poly.outer);
      const pieces = placements.filter((p) => p.building === b);
      const kit = KIT_BUILDINGS[b.kind as keyof typeof KIT_BUILDINGS];
      const box = boxes.get(kit.id)!;
      const name = `${b.kind} ${b.name ?? ''} (${fit.length.toFixed(0)} by ${fit.width.toFixed(0)})`;
      let covered = 0;
      for (const p of pieces) {
        // The piece's box corners, as the app places the model (src/render/models/library.ts).
        rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.facing + Math.PI / 2);
        matrix.compose(new THREE.Vector3(p.x, p.h, -p.y), rotation, new THREE.Vector3(p.sx, p.sy, p.sz));
        let top = -Infinity;
        for (const [cx, cy, cz] of [
          [box[0], box[1], box[2]],
          [box[0] + box[3], box[1] + box[4], box[2]],
          [box[0], box[1], box[2] + box[5]],
          [box[0] + box[3], box[1], box[2] + box[5]],
        ]) {
          at.set(cx, cy, cz).applyMatrix4(matrix);
          top = Math.max(top, at.y);
          // A round tank is judged by its circle below; its box's corners stand out of a round footprint's.
          if (kit.lay === 'one') continue;
          // Within the footprint's box, along and across it.
          const dx = at.x - fit.x;
          const dy = -at.z - fit.y;
          const u = dx * Math.cos(fit.angle) + dy * Math.sin(fit.angle);
          const v = -dx * Math.sin(fit.angle) + dy * Math.cos(fit.angle);
          if (Math.abs(u) > fit.length / 2 + 0.05 || Math.abs(v) > fit.width / 2 + 0.05) faults.push(`${name}: a piece reaches out of its box (${u.toFixed(1)}, ${v.toFixed(1)})`);
        }
        if (b.height > 0 && Math.abs(top - b.height) > 0.05) faults.push(`${name}: ${top.toFixed(1)} m tall where the map has ${b.height} m`);
        covered += box[3] * p.sx * box[5] * p.sz;
        // Proportions: a tank round; a hangar's shape; a shed's or car park's front its own width.
        const across = p.sx / p.sz;
        if (kit.lay === 'one' && Math.abs(across - box[5] / box[3]) > 0.01) faults.push(`${name}: not round`);
        if (kit.lay === 'one') {
          // As wide as the footprint is across, centred on it.
          const diameter = box[3] * p.sx;
          if (Math.abs(diameter - (fit.length + fit.width) / 2) > 0.05) faults.push(`${name}: ${diameter.toFixed(1)} m across`);
          at.set(box[0] + box[3] / 2, 0, box[2] + box[5] / 2).applyMatrix4(matrix);
          if (Math.hypot(at.x - fit.x, -at.z - fit.y) > 0.05) faults.push(`${name}: off its footprint's middle`);
        }
        if (kit.lay === 'length' && (across < 0.75 || across > 1.34)) faults.push(`${name}: a hangar ${across.toFixed(2)} out of its shape`);
        if ((kit.lay === 'grid' || kit.lay === 'bays') && (p.sx < 0.6 || p.sx > 1.6)) faults.push(`${name}: its front ${p.sx.toFixed(2)} of the model's width`);
        if (kit.lay === 'grid' && (p.sz < 0.6 || p.sz > 1.6)) faults.push(`${name}: its depth ${p.sz.toFixed(2)} of the model's`);
      }
      // Laid end to end and side by side, the pieces fill the box: a tank's circle fills its square's share.
      const box2 = fit.length * fit.width;
      const share = kit.lay === 'one' ? 1 : covered / box2;
      if (Math.abs(share - 1) > 0.01) faults.push(`${name}: pieces cover ${(share * 100).toFixed(0)}% of its box`);
    }
    expect(faults.slice(0, 8)).toEqual([]);
  });
});
