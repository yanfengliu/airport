// Our own models of the landmarks Polyfork's kit has only a generic stand-in for: SFO's torch-shaped
// control tower, 67 m to the tip of its mast, lofted through the profile of the real one in rings of
// twenty-four flat faces. Its cab's glass is a slot of its own, which the app lights at night.

import { ModelKit, type V3 } from './kit.ts';
import type { OriginalSpec } from './trains.ts';

const SIDES = 24;

/** A ring at radius r and height h, going round clockwise seen from above, so that faces lofted upward face out. */
function ring(r: number, h: number): V3[] {
  return Array.from({ length: SIDES }, (_, i) => {
    const t = -(i / SIDES) * Math.PI * 2;
    return [r * Math.cos(t), h, r * Math.sin(t)];
  });
}

function sfoTower(): ModelKit {
  const kit = new ModelKit();
  const concrete = kit.colour('concrete', 0xe8e9e6);
  const glass = kit.colour('glass', 0x2f4a55);
  const mullion = kit.colour('mullion', 0x9aa3a8);
  // The shaft, flaring out to carry the cab.
  const shaft: [number, number][] = [[5.4, 0], [4.7, 6], [3.3, 15], [2.9, 40], [3.5, 46], [5.6, 51], [8, 54.2], [8.5, 55]];
  kit.loft(0, shaft.map(([r, h]) => ring(r, h)), () => concrete, [concrete, concrete]);
  // The cab: glass all round, with a mullion every fourth face.
  kit.loft(0, [ring(8.5, 55), ring(9.1, 58.8)], (_, side) => (side % 4 === 0 ? mullion : glass), null);
  // The roof, its crown and the mast.
  const roof: [number, number][] = [[9.1, 58.8], [9.6, 59.1], [9.3, 59.7], [6.5, 61.2], [1.6, 62.4], [0.35, 63], [0.3, 67]];
  kit.loft(0, roof.map(([r, h]) => ring(r, h)), () => concrete, [concrete, concrete]);
  return kit;
}

export const LANDMARK_MODELS: OriginalSpec[] = [{ id: 'sfo-control-tower', name: 'SFO Control Tower', category: 'building', build: sfoTower }];
