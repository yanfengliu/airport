// The ground equipment round a parked aircraft, placed as the layer places it
// (src/render/dynamic/gse-places.ts), each piece made of the parts the model is built from
// (src/render/models/gse-parts.ts), round the aircraft as it is drawn (src/shared/airframe.ts): no
// two pieces stand in each other, and none stands in a wing, an engine, the tailplane or the
// fuselage. Review 1 found the fuel truck, moved behind a low wing, standing in the baggage carts
// there (UA 1791's B752 at F20, seed 7 at 08:30). Bound: every type in the fleet, with every piece
// of equipment out at once.

import { describe, expect, it } from 'vitest';
import { gseAround, type GsePlace } from '../src/render/dynamic/gse-places.ts';
import { gseParts, partExtent } from '../src/render/models/gse-parts.ts';
import { airframe, surfaceOver, type Surface } from '../src/shared/airframe.ts';
import { AIRCRAFT, type AircraftType } from '../src/sim/fleet.ts';

/** Room kept between two things, metres: closer than this, they are in each other. */
const TOUCH = 0.01;

/** One part of a piece placed round the aircraft: its corners on the ground, in the aircraft's frame (x forward from its middle, y to its left), and its heights. */
interface Part {
  name: string;
  corners: [number, number][];
  z0: number;
  z1: number;
}

function partsOf(p: GsePlace, index: number): Part[] {
  const c = Math.cos(p.turn);
  const s = Math.sin(p.turn);
  return gseParts(p.kind).map((part, i) => {
    const e = partExtent(part);
    const corners = ([[e.x0, e.y0], [e.x1, e.y0], [e.x1, e.y1], [e.x0, e.y1]] as const).map(([x, y]): [number, number] => [p.along + x * c - y * s, p.side + x * s + y * c]);
    return { name: `${p.kind} ${index} part ${i}`, corners, z0: e.z0, z1: e.z1 };
  });
}

/** How far two convex outlines on the ground overlap, along the line that parts them best; 0 or less when they are apart. */
function overlap(a: readonly [number, number][], b: readonly [number, number][]): number {
  let least = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 1) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const nx = y0 - y1;
      const ny = x1 - x0;
      const len = Math.hypot(nx, ny);
      const project = (q: readonly [number, number][]): [number, number] => {
        const d = q.map(([x, y]) => (x * nx + y * ny) / len);
        return [Math.min(...d), Math.max(...d)];
      };
      const [amin, amax] = project(a);
      const [bmin, bmax] = project(b);
      least = Math.min(least, Math.min(amax, bmax) - Math.max(amin, bmin));
    }
  }
  return least;
}

/** Where a convex outline crosses the line across the aircraft `y` out from its centreline, along x; null if it does not. */
function crossing(corners: readonly [number, number][], y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < corners.length; i += 1) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % corners.length];
    if ((y < Math.min(y0, y1)) || (y > Math.max(y0, y1))) continue;
    const xs = y0 === y1 ? [x0, x1] : [x0 + ((y - y0) / (y1 - y0)) * (x1 - x0)];
    for (const x of xs) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** What of the drawn aircraft a part stands in, if anything. */
function inAircraft(type: AircraftType, part: Part): string | null {
  const f = airframe(type);
  const ys = part.corners.map((c) => c[1]);
  // Across the part's width, every 2 cm: the wings and tailplane, as slabs between their underside and top.
  const surfaces: [string, Surface][] = [['wing', f.sides[0].wing], ['tailplane', f.sides[0].stabiliser]];
  for (let y = Math.min(...ys) + TOUCH; y <= Math.max(...ys) - TOUCH; y += 0.02) {
    const at = crossing(part.corners, y);
    if (!at) continue;
    for (const [name, s] of surfaces) {
      const over = surfaceOver(s, y);
      if (over && at[0] < over.lead - TOUCH && at[1] > over.trail + TOUCH && part.z1 > over.under + TOUCH && part.z0 < over.top - TOUCH) return `${name} ${y.toFixed(2)} m out`;
    }
  }
  for (const s of f.sides) {
    for (const e of s.engines) {
      const back = e.stations[0][0];
      const nacelle: [number, number][] = [[back, e.y - e.radius], [e.front, e.y - e.radius], [e.front, e.y + e.radius], [back, e.y + e.radius]];
      if (overlap(part.corners, nacelle) > TOUCH && part.z1 > e.z - e.radius + TOUCH && part.z0 < e.z + e.radius - TOUCH) return `engine at ${e.y.toFixed(1)} m`;
    }
  }
  const body: [number, number][] = [[-f.half, -f.ry], [f.half, -f.ry], [f.half, f.ry], [-f.half, f.ry]];
  if (overlap(part.corners, body) > TOUCH && part.z1 > f.zc - f.rz + TOUCH) return 'fuselage';
  return null;
}

describe('ground equipment round a parked aircraft', () => {
  // Everything out at once: doors open with bags coming and going, catering, fuel, and stairs at a remote stand.
  const busy = (type: AircraftType) => ({ phase: 'parked' as const, type, visit: { onBlockAt: 0, etd: 20_000, doorsClosed: false, deplaned: 100, boardingOpen: false, rotation: { paxIn: 100 } } });

  it('puts out every piece for a busy turnaround', () => {
    for (const type of Object.values(AIRCRAFT)) {
      const kinds = gseAround(busy(type), 1_000, true).map((p) => p.kind).sort();
      const wide = type.body === 'wide' || type.body === 'super';
      expect(kinds).toEqual((wide ? ['carts', 'carts', 'catering', 'fuel', 'loader', 'loader', 'power', 'stairs'] : ['carts', 'catering', 'fuel', 'loader', 'power', 'stairs']));
    }
  });

  it('stands no piece in another, for every type', () => {
    const faults: string[] = [];
    for (const type of Object.values(AIRCRAFT)) {
      const pieces = gseAround(busy(type), 1_000, true).map(partsOf);
      for (let i = 0; i < pieces.length; i += 1) {
        for (let j = i + 1; j < pieces.length; j += 1) {
          for (const a of pieces[i]) {
            for (const b of pieces[j]) {
              const deep = Math.min(overlap(a.corners, b.corners), Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));
              if (deep > TOUCH) faults.push(`${type.id}: ${a.name} in ${b.name} by ${deep.toFixed(2)} m`);
            }
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it('stands no piece in the drawn wing, an engine, the tailplane or the fuselage, for every type', () => {
    const faults: string[] = [];
    for (const type of Object.values(AIRCRAFT)) {
      for (const [i, place] of gseAround(busy(type), 1_000, true).entries()) {
        for (const part of partsOf(place, i)) {
          const hit = inAircraft(type, part);
          if (hit) faults.push(`${type.id}: ${part.name} in the ${hit}`);
        }
      }
    }
    expect(faults).toEqual([]);
  });
});
