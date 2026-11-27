// Our own model of the A380, which Polyfork has no model of: built with the kit in Polyfork's
// manner from the shape src/shared/airframe.ts gives the type (the one the stands are judged by),
// so that what is drawn is what is judged. Colour slots for the fuselage, belly, windows, wings,
// engines, gear and glass, and a tail the app paints in the airline's colour; the nose and main
// gear are parts that fold up into the fuselage in the 'gear-up' pose.

import { airframe, section, type Surface } from '../../../src/shared/airframe.ts';
import { AIRCRAFT } from '../../../src/sim/fleet.ts';
import { ModelKit, type V3 } from './kit.ts';
import type { OriginalSpec } from './trains.ts';

/** The aircraft's body frame (x forward, y left, z up) in the kit's (x left, y up, z forward). */
const k = (x: number, y: number, z: number): V3 => [y, z, x];

function doubleDeck(): ModelKit {
  const kit = new ModelKit();
  const type = AIRCRAFT.A388;
  const f = airframe(type);
  const s = {
    body: kit.colour('fuselage', 0xf1f3f5),
    belly: kit.colour('belly', 0xb9c0c7),
    windows: kit.colour('windows', 0x24303b),
    wing: kit.colour('wing', 0xc9d0d6),
    engine: kit.colour('engine', 0xdde2e6),
    intake: kit.colour('intake', 0x2b3036),
    gear: kit.colour('gear', 0x3a3f45),
    tyre: kit.colour('tyre', 0x1b1d20),
    glass: kit.colour('glass', 0x1d2833),
    livery: kit.colour('livery', 0x1f4f8f),
  };
  // The fuselage: an ellipse at each station, sixteen sides, the lower third the belly's colour.
  const SIDES = 16;
  const rings = f.stations.map(([x, zc, ry, rz]) =>
    Array.from({ length: SIDES }, (_, i) => {
      const t = (i / SIDES) * Math.PI * 2 - Math.PI / 2;
      return k(x, ry * Math.cos(t), zc + rz * Math.sin(t));
    }),
  );
  kit.loft(0, rings, (_, side) => (side <= 2 || side >= 14 ? s.belly : s.body), [s.body, s.body]);
  // Two decks of windows: dark bands a hair proud of the sides over the cabin, and the flight deck's glass.
  const { from, to, y } = f.windows;
  for (const z of [f.zc - f.rz * 0.12, f.zc + f.rz * 0.42]) {
    for (const side of [1, -1]) {
      const yy = side * (y * Math.cos(Math.asin(Math.min(1, Math.abs(z - f.zc) / f.rz))) + 0.02);
      const a = k(from, yy, z - 0.25);
      const b = k(to, yy, z - 0.25);
      const c = k(to, yy, z + 0.25);
      const d = k(from, yy, z + 0.25);
      if (side > 0) kit.quad(0, s.windows, b, a, d, c);
      else kit.quad(0, s.windows, a, b, c, d);
    }
  }
  const deck = f.deckX;
  for (const side of [1, -1]) {
    const a = k(deck - 0.6, side * f.ry * 0.55, f.zc + f.rz * 0.35);
    const b = k(deck + 0.7, side * f.ry * 0.42, f.zc + f.rz * 0.3);
    const c = k(deck + 0.5, side * f.ry * 0.3, f.zc + f.rz * 0.62);
    const d = k(deck - 0.6, side * f.ry * 0.45, f.zc + f.rz * 0.7);
    if (side > 0) kit.quad(0, s.glass, b, a, d, c);
    else kit.quad(0, s.glass, a, b, c, d);
  }
  // Wings, tip devices, tailplane and fin as the airframe's surfaces: lofts between their end sections.
  const surface = (sf: Surface, slot: number): void => {
    const root = section(sf.root, sf.rootChord, sf.rootThick, sf.upright).map(([x, yy, z]) => k(x, yy, z));
    const tip = section(sf.tip, sf.tipChord, sf.tipThick, sf.upright).map(([x, yy, z]) => k(x, yy, z));
    // The sections go round one way on the left and the other on the right: keep them outward.
    const left = sf.upright ? true : sf.tip[1] > 0;
    kit.loft(0, left ? [root, tip] : [tip, root], () => slot, [slot, slot]);
  };
  for (const side of f.sides) {
    surface(side.wing, s.wing);
    if (side.winglet) surface(side.winglet, s.livery);
    surface(side.stabiliser, s.wing);
    // Engines: nacelles lofted through the airframe's stations for them, ten-sided, with dark intakes.
    for (const e of side.engines) {
      const back = e.stations[0][0];
      const nacelle = e.stations.map(([x, z, ry, rz]) =>
        Array.from({ length: 10 }, (_, i) => {
          const t = (i / 10) * Math.PI * 2;
          return k(x, e.y + ry * Math.cos(t), z + rz * Math.sin(t));
        }),
      );
      kit.loft(0, nacelle, () => s.engine, [s.engine, s.intake]);
      // The pylon up to the wing.
      kit.box(0, s.wing, k(back + e.length * 0.2, e.y - 0.15, e.z + e.radius * 0.6), k(e.front - e.length * 0.1, e.y + 0.15, e.leZ));
    }
  }
  surface(f.fin, s.livery);
  // The gear: a nose gear and a main gear each side, each a part that folds up into the fuselage.
  const wheel = (bone: number, x: number, yy: number, r: number, width: number): void => {
    kit.cylinder(bone, s.tyre, k(x, yy - width / 2, r), k(x, yy + width / 2, r), r, 10);
  };
  const strutTop = f.zc - f.rz * 0.85;
  const nose = kit.part('gear-nose', k(f.noseGearX, 0, strutTop));
  kit.box(nose, s.gear, k(f.noseGearX - 0.12, -0.12, f.wheelR), k(f.noseGearX + 0.12, 0.12, strutTop));
  for (const dy of [-0.32, 0.32]) wheel(nose, f.noseGearX, dy, f.wheelR * 0.85, 0.3);
  for (const side of [1, -1]) {
    const yy = side * f.track;
    const bone = kit.part(side > 0 ? 'gear-main-l' : 'gear-main-r', k(f.mainGearX, yy, strutTop));
    kit.box(bone, s.gear, k(f.mainGearX - 0.16, yy - 0.16, f.wheelR), k(f.mainGearX + 0.16, yy + 0.16, strutTop));
    kit.box(bone, s.gear, k(f.mainGearX + f.bogies[0] - 0.2, yy - 0.12, f.wheelR - 0.1), k(f.mainGearX + f.bogies[f.bogies.length - 1] + 0.2, yy + 0.12, f.wheelR + 0.1));
    for (const dx of f.bogies) for (const dy of [-0.42, 0.42]) wheel(bone, f.mainGearX + dx, yy + dy, f.wheelR * 0.88, 0.42);
  }
  // Gear up: the main gear swings in towards the centreline and up, the nose gear forward and up.
  kit.pose('gear-up', {
    'gear-main-l': { turn: { axis: [0, 0, 1], angle: -Math.PI / 2 } },
    'gear-main-r': { turn: { axis: [0, 0, 1], angle: Math.PI / 2 } },
    'gear-nose': { turn: { axis: [1, 0, 0], angle: -Math.PI / 2 } },
  });
  return kit;
}

export const AIRLINER_MODELS: OriginalSpec[] = [{ id: 'double-deck-airliner', name: 'Double-Deck Airliner', category: 'vehicle', build: doubleDeck }];
