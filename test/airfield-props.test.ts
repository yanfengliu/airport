// The windsocks and the approach-slope lights stand beside the runways where they are usually put,
// 300 m in from the landing threshold on the left, unless a taxiway runs there: at 10L one crosses
// 14 m from where they would stand, and aircraft taxiing out would have run over the lights and
// through the windsock; at 01L one runs alongside on the left; and the airfield's service roads
// pass close by several runway ends, where seven windsocks stood on a road's edge. Bound: one
// windsock and one row of four lights at every runway end, every one clear of every taxiway's
// centreline by a wide-body's half span (the windsock) or its engines (the lights), clear of the
// middle of every road and off every runway, each row across the landing direction from the
// runway's edge outwards, facing the approach.

import { describe, expect, it } from 'vitest';
import { PAPI_CLEAR, ROAD_CLEAR, WINDSOCK_CLEAR, airfieldPropPlaces } from '../src/render/static/airfield-props.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

describe('the airfield furniture', () => {
  const { airfield, roads } = loadLayoutFromDisk();
  const { socks, lights } = airfieldPropPlaces(airfield, roads);
  const ends = airfield.runways.length * 2;

  it('stands at every runway end clear of the taxiways and roads, and off the runways', () => {
    expect(socks.length).toBe(ends);
    expect(lights.length).toBe(ends * 4);
    const faults: string[] = [];
    for (const [kind, places, margin] of [['windsock', socks, WINDSOCK_CLEAR], ['light unit', lights, PAPI_CLEAR]] as const) {
      for (const p of places) {
        for (const e of airfield.edges) {
          if (e.kind !== 'twy') continue;
          for (let i = 2; i < e.pts.length; i += 2) {
            const d = toSegment(p.x, p.y, e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1]);
            if (d < margin) faults.push(`a ${kind} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) ${d.toFixed(1)} m from a taxiway`);
          }
        }
        for (const e of roads.edges) {
          for (let i = 3; i < e.pts.length; i += 3) {
            const d = toSegment(p.x, p.y, e.pts[i - 3], e.pts[i - 2], e.pts[i], e.pts[i + 1]);
            if (d < ROAD_CLEAR) faults.push(`a ${kind} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) ${d.toFixed(1)} m from the middle of a road`);
          }
        }
        for (const r of airfield.runways) {
          const [a, b] = r.ends;
          const d = toSegment(p.x, p.y, a.x, a.y, b.x, b.y) - r.width / 2;
          if (d < 10) faults.push(`a ${kind} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) ${d.toFixed(1)} m from the edge of ${r.id}`);
        }
      }
    }
    expect(faults.slice(0, 8)).toEqual([]);
  });

  it('puts each set of lights in a row across its landing direction, facing the approach', () => {
    let left = 0;
    for (let i = 0; i < lights.length; i += 4) {
      const row = lights.slice(i, i + 4);
      // One line across, 9 m apart, all facing the same way.
      for (let k = 1; k < 4; k += 1) {
        expect(Math.hypot(row[k].x - row[k - 1].x, row[k].y - row[k - 1].y)).toBeCloseTo(9, 3);
        expect(row[k].facing).toBe(row[0].facing);
      }
      // Facing back down the approach: the row runs out square to the way an aircraft lands.
      const landing = row[0].facing + Math.PI;
      const across = Math.atan2(row[3].y - row[0].y, row[3].x - row[0].x);
      const turn = Math.atan2(Math.sin(across - landing), Math.cos(across - landing));
      expect(Math.abs(turn)).toBeCloseTo(Math.PI / 2, 3);
      if (turn > 0) left += 1;
    }
    // On the left wherever there is room, as they usually are.
    expect(left).toBeGreaterThanOrEqual(ends - 2);
  });
});
