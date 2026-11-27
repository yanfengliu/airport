// The ground equipment round a parked aircraft, placed as the layer places it
// (src/render/dynamic/gse-places.ts), each piece the box its Polyfork model is drawn in
// (public/models/index.json), round the aircraft as it is drawn (src/shared/airframe.ts): no two
// pieces stand in each other, and none stands in a wing, an engine, the tailplane or the
// fuselage. Review 1 found the fuel truck, moved behind a low wing, standing in the baggage carts
// there (UA 1791's B752 at F20, seed 7 at 08:30). Bound: every type in the fleet, with every piece
// it can have out at once, at a stand with a jet bridge and at one without.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GSE_MODELS, gseAround, pushbackLayout, turnaroundLayout, type GseKind, type GsePlace } from '../src/render/dynamic/gse-places.ts';
import { airframe, surfaceOver, type Surface } from '../src/shared/airframe.ts';
import { AIRCRAFT, type AircraftType } from '../src/sim/fleet.ts';
import { repoRoot } from './helpers/layout.ts';

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
  const m = GSE_MODELS[p.kind];
  const back = p.length ? -p.length / 2 : m.back;
  const front = p.length ? p.length / 2 : m.front;
  const c = Math.cos(p.turn);
  const s = Math.sin(p.turn);
  // The model's front is the way the piece heads; its left is to the left of that.
  const corners = ([[back, m.right], [front, m.right], [front, m.left], [back, m.left]] as const).map(([u, v]): [number, number] => [p.along + u * c - v * s, p.side + u * s + v * c]);
  return [{ name: `${p.kind} ${index}`, corners, z0: p.h, z1: p.h + m.top }];
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
  const types = Object.values(AIRCRAFT);
  const layouts = (type: AircraftType): [string, readonly GsePlace[]][] => [['at a gate', turnaroundLayout(type, false)], ['at a remote stand', turnaroundLayout(type, true)]];

  it('is drawn with the models it is laid out by, at their sizes', () => {
    const index = JSON.parse(readFileSync(join(repoRoot, 'public', 'models', 'index.json'), 'utf8')) as { id: string; box: number[] }[];
    const list = Array.isArray(index) ? index : (index as unknown as { models: { id: string; box: number[] }[] }).models;
    for (const [kind, m] of Object.entries(GSE_MODELS) as [GseKind, (typeof GSE_MODELS)[GseKind]][]) {
      if (!m.id) continue;
      const model = list.find((e) => e.id === m.id);
      expect(model, `${kind}: ${m.id} converted`).toBeDefined();
      const [x0, , z0, sx, sy, sz] = model!.box;
      expect(m.right, `${kind} right`).toBeCloseTo(x0, 1);
      expect(m.left, `${kind} left`).toBeCloseTo(x0 + sx, 1);
      expect(m.back, `${kind} back`).toBeCloseTo(z0, 1);
      expect(m.front, `${kind} front`).toBeCloseTo(z0 + sz, 1);
      if (kind !== 'stairsLow') expect(m.top, `${kind} top`).toBeCloseTo(model!.box[1] + sy, 1);
    }
  });

  it('has every piece out for a busy turnaround, and stairs and a bus only where there is no bridge', () => {
    // Everything out at once: doors open with bags coming and going, catering, fuel, the lavatory truck.
    const busy = (type: AircraftType) => ({ phase: 'parked' as const, type, visit: { onBlockAt: 0, etd: 20_000, doorsClosed: false, deplaned: 100, boardingOpen: false, rotation: { paxIn: 100 } } });
    for (const type of types) {
      const wide = type.body === 'wide' || type.body === 'super';
      const count = (list: GsePlace[], kind: GseKind) => list.filter((p) => p.kind === kind).length;
      const gate = gseAround(busy(type), 1_000, false);
      expect(count(gate, wide ? 'kloader' : 'loader'), type.id).toBe(wide ? 2 : 1);
      expect(count(gate, wide ? 'dolly' : 'cart'), type.id).toBe(wide ? 6 : 3);
      for (const kind of ['power', 'catering', 'hydrant', 'lavatory'] as GseKind[]) expect(count(gate, kind), `${type.id} ${kind}`).toBe(1);
      expect(count(gate, 'stairs') + count(gate, 'stairsLow') + count(gate, 'bus') + count(gate, 'tanker'), type.id).toBe(0);
      const remote = gseAround(busy(type), 1_000, true);
      expect(count(remote, wide ? 'stairs' : 'stairsLow'), type.id).toBe(wide ? 1 : 2);
      expect(count(remote, 'tanker'), type.id).toBe(1);
      expect(count(remote, 'hydrant'), type.id).toBe(0);
    }
  });

  it('stands no piece in another, for every type', () => {
    const faults: string[] = [];
    for (const type of types) {
      for (const [where, layout] of layouts(type)) {
        const pieces = layout.map(partsOf);
        for (let i = 0; i < pieces.length; i += 1) {
          for (let j = i + 1; j < pieces.length; j += 1) {
            for (const a of pieces[i]) {
              for (const b of pieces[j]) {
                // A container stands on its dolly.
                if ((a.name.startsWith('uld') && b.name.startsWith('dolly')) || (b.name.startsWith('uld') && a.name.startsWith('dolly'))) continue;
                const deep = Math.min(overlap(a.corners, b.corners), Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));
                if (deep > TOUCH) faults.push(`${type.id} ${where}: ${a.name} in ${b.name} by ${deep.toFixed(2)} m`);
              }
            }
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it('stands no piece in the drawn wing, an engine, the tailplane or the fuselage, for every type', () => {
    const faults: string[] = [];
    for (const type of types) {
      for (const [where, layout] of [...layouts(type), ['pushing back', pushbackLayout(type)] as [string, readonly GsePlace[]]]) {
        for (const [i, place] of layout.entries()) {
          for (const part of partsOf(place, i)) {
            const hit = inAircraft(type, part);
            if (hit) faults.push(`${type.id} ${where}: ${part.name} in the ${hit}`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it('puts each container on a dolly and each train behind its tug', () => {
    for (const type of types) {
      const layout = turnaroundLayout(type, false);
      for (const uld of layout.filter((p) => p.kind === 'uld')) {
        const under = layout.filter((p) => p.kind === 'dolly' && Math.abs(p.side - uld.side) < 0.01 && Math.abs(p.along - uld.along) < 1.6);
        expect(under.length, `${type.id}: a dolly under the container at ${uld.along.toFixed(1)}`).toBe(1);
      }
    }
  });
});
