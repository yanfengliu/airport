// The airfield's furniture stands where such things usually stand, or as near as is clear, and
// nothing of it is in anything's way. The windsocks and the approach-slope lights: 300 m in from the
// landing threshold, on the left, unless a taxiway runs there (at 10L one crosses 14 m from where
// they would stand, and aircraft taxiing out would have run over the lights and through the
// windsock; at 01L one runs alongside on the left; and the airfield's service roads pass close by
// several runway ends, where seven windsocks stood on a road's edge). The ILS of every runway end the
// simulation lands on: the localizer's array across the centreline beyond the far end, the
// glide-path antenna beside the touchdown zone. At the gates: a floodlight mast where there is room
// ahead of the aircraft, clear of every aircraft the gate and its neighbours take and of the
// bridges, else the floodlight on the terminal's roof; the docking display on the terminal's face,
// looking down the stand. Bound: every piece placed from the committed layout; the moving bridges
// are kept off the masts by test/bridges.test.ts.

import { describe, expect, it } from 'vitest';
import { BEACON_CLEAR, GLIDE_CLEAR, ILS_ENDS, LOCALIZER_CLEAR, MAST_CLEAR, MAST_LAMP, PAPI_CLEAR, RAIL_CLEAR, ROAD_CLEAR, WINDSOCK_CLEAR, airfieldFurniture, airfieldLamps } from '../src/render/static/airfield-props.ts';
import { JET_BRIDGE, bridgeLines } from '../src/render/static/bridges.ts';
import { AIRCRAFT } from '../src/sim/fleet.ts';
import { Sim } from '../src/sim/sim.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';
import { once } from './helpers/once.ts';

function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function inside(ring: readonly number[], x: number, y: number): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    if (ring[i + 1] > y !== ring[j + 1] > y && x < ((ring[j] - ring[i]) * (y - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) within = !within;
  }
  return within;
}

/** The nearest a ring's edges come to a point; 0 inside. */
function ringReach(ring: readonly number[], x: number, y: number): number {
  if (inside(ring, x, y)) return 0;
  let least = Infinity;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) least = Math.min(least, toSegment(x, y, ring[j], ring[j + 1], ring[i], ring[i + 1]));
  return least;
}

describe('the airfield furniture', () => {
  const layout = loadLayoutFromDisk();
  const { airfield, roads } = layout;
  const furniture = once(() => airfieldFurniture(layout));
  const ends = airfield.runways.length * 2;
  const fromTaxiways = (x: number, y: number): number => {
    let least = Infinity;
    for (const e of airfield.edges) if (e.kind === 'twy') for (let i = 2; i < e.pts.length; i += 2) least = Math.min(least, toSegment(x, y, e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1]));
    return least;
  };
  const fromRoads = (x: number, y: number): number => {
    let least = Infinity;
    for (const e of roads.edges) for (let i = 3; i < e.pts.length; i += 3) least = Math.min(least, toSegment(x, y, e.pts[i - 3], e.pts[i - 2], e.pts[i], e.pts[i + 1]));
    return least;
  };
  const fromRails = (x: number, y: number): number => {
    let least = Infinity;
    for (const l of layout.rail.lines) for (let i = 3; i < l.pts.length; i += 3) least = Math.min(least, toSegment(x, y, l.pts[i - 3], l.pts[i - 2], l.pts[i], l.pts[i + 1]));
    return least;
  };
  const fromRunways = (x: number, y: number): number => Math.min(...airfield.runways.map((r) => toSegment(x, y, r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y) - r.width / 2));
  /** A runway end, the far end, and the unit vector landing from one to the other. */
  const runwayEnd = (name: string) => {
    const runway = airfield.runways.find((r) => r.ends.some((e) => e.name === name))!;
    const end = runway.ends.find((e) => e.name === name)!;
    const far = runway.ends.find((e) => e.name !== name)!;
    const length = Math.hypot(far.x - end.x, far.y - end.y);
    return { runway, end, far, length, ux: (far.x - end.x) / length, uy: (far.y - end.y) / length };
  };

  it('stands at every runway end clear of the taxiways and roads, and off the runways', () => {
    const { socks, lights } = furniture();
    expect(socks.length).toBe(ends);
    expect(lights.length).toBe(ends * 4);
    const faults: string[] = [];
    for (const [kind, places, margin] of [['windsock', socks, WINDSOCK_CLEAR], ['light unit', lights, PAPI_CLEAR]] as const) {
      for (const p of places) {
        const at = `a ${kind} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`;
        if (fromTaxiways(p.x, p.y) < margin) faults.push(`${at} ${fromTaxiways(p.x, p.y).toFixed(1)} m from a taxiway`);
        if (fromRoads(p.x, p.y) < ROAD_CLEAR) faults.push(`${at} ${fromRoads(p.x, p.y).toFixed(1)} m from the middle of a road`);
        if (fromRunways(p.x, p.y) < 10) faults.push(`${at} ${fromRunways(p.x, p.y).toFixed(1)} m from a runway's edge`);
        if (fromRails(p.x, p.y) < RAIL_CLEAR) faults.push(`${at} ${fromRails(p.x, p.y).toFixed(1)} m from a railway`);
      }
    }
    expect(faults.slice(0, 8)).toEqual([]);
  });

  it('puts each set of lights in a row across its landing direction, facing the approach', () => {
    const { lights } = furniture();
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

  it('gives every runway end landed on its localizer, across the centreline beyond the far end, facing the approach', () => {
    const { localizers } = furniture();
    expect(localizers.map((l) => l.end).sort()).toEqual([...ILS_ENDS].sort());
    for (const l of localizers) {
      const { far, ux, uy } = runwayEnd(l.end);
      const beyond = (l.x - far.x) * ux + (l.y - far.y) * uy;
      expect(beyond, `${l.end} beyond the far end`).toBeGreaterThan(60);
      expect(beyond, `${l.end} beyond the far end`).toBeLessThan(310);
      expect(Math.abs(-(l.x - far.x) * uy + (l.y - far.y) * ux), `${l.end} on the centreline`).toBeLessThan(0.1);
      expect(Math.cos(l.facing - Math.atan2(-uy, -ux)), `${l.end} facing the approach`).toBeCloseTo(1, 6);
      expect(layout.land.airport.some((p) => inside(p.outer, l.x, l.y)), `${l.end} on the airport`).toBe(true);
      expect(fromTaxiways(l.x, l.y), `${l.end} from the taxiways`).toBeGreaterThanOrEqual(LOCALIZER_CLEAR);
      expect(fromRoads(l.x, l.y), `${l.end} from the roads`).toBeGreaterThanOrEqual(ROAD_CLEAR);
      expect(fromRails(l.x, l.y), `${l.end} from the railways`).toBeGreaterThanOrEqual(RAIL_CLEAR);
    }
  });

  it('puts the glide-path antennas beside the touchdown zones, clear of the taxiways, roads, other runways and the lights', () => {
    const { glidePaths, socks, lights } = furniture();
    // 19R has no ground near its touchdown zone clear of the taxiways and its parallel runway.
    expect(glidePaths.length).toBeGreaterThanOrEqual(ILS_ENDS.length - 1);
    for (const g of glidePaths) {
      const { runway, end, ux, uy } = runwayEnd(g.end);
      const tx = end.x + ux * end.displaced;
      const ty = end.y + uy * end.displaced;
      const along = (g.x - tx) * ux + (g.y - ty) * uy;
      const off = Math.abs(-(g.x - tx) * uy + (g.y - ty) * ux);
      expect(along, `${g.end} by the touchdown zone`).toBeGreaterThanOrEqual(150);
      expect(along, `${g.end} by the touchdown zone`).toBeLessThanOrEqual(450);
      expect(off, `${g.end} out from the centreline`).toBeGreaterThanOrEqual(100);
      expect(off, `${g.end} out from the centreline`).toBeLessThanOrEqual(180);
      expect(fromTaxiways(g.x, g.y), `${g.end} from the taxiways`).toBeGreaterThanOrEqual(GLIDE_CLEAR);
      expect(fromRoads(g.x, g.y), `${g.end} from the roads`).toBeGreaterThanOrEqual(ROAD_CLEAR);
      expect(fromRails(g.x, g.y), `${g.end} from the railways`).toBeGreaterThanOrEqual(RAIL_CLEAR);
      for (const r of airfield.runways) if (r !== runway) expect(toSegment(g.x, g.y, r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y) - r.width / 2, `${g.end} off ${r.id}`).toBeGreaterThanOrEqual(75);
      for (const p of [...socks, ...lights]) expect(Math.hypot(p.x - g.x, p.y - g.y), `${g.end} from the lights`).toBeGreaterThanOrEqual(30);
    }
  });

  it("lights every gate, from a mast clear of every aircraft it and its neighbours take, of the bridges and of buildings, or from the terminal's face", () => {
    const { masts, floodlights, beacons } = furniture();
    const gates = airfield.stands.filter((s) => s.contact);
    expect(floodlights.map((f) => f.stand).sort()).toEqual(gates.map((s) => s.id).sort());
    expect(masts.length).toBeGreaterThan(gates.length / 3);
    for (const m of masts) expect(floodlights.find((f) => f.stand === m.stand), `${m.stand}'s lamp on its mast`).toMatchObject({ x: m.x, y: m.y, h: MAST_LAMP });
    const sim = new Sim(layout, { seed: 7, startTime: 4 * 3600 });
    const lines = bridgeLines(layout);
    const rings = [...layout.terminals.buildings.map((t) => t.poly.outer), ...layout.buildings.buildings.map((b) => b.poly.outer)];
    const faults: string[] = [];
    // A mast's base and pole, round it: about a metre and a half.
    const RADIUS = 1.5;
    for (const m of masts) {
      for (const [stand, span] of sim.usableStands) {
        const s = airfield.stands.find((x) => x.id === stand)!;
        if (Math.hypot(s.x - m.x, s.y - m.y) > 120) continue;
        for (const type of Object.values(AIRCRAFT)) {
          if (type.span > span + 0.5) continue;
          const shape = sim.airside.parkedShape(stand, type);
          if (!shape) continue;
          for (const [k, poly] of shape.polygons.entries()) {
            if (ringReach(poly, m.x, m.y) < RADIUS) faults.push(`${m.stand}'s mast in part ${k} of a ${type.id} at ${stand}`);
          }
        }
      }
      if (rings.some((r) => ringReach(r, m.x, m.y) < MAST_CLEAR.building)) faults.push(`${m.stand}'s mast against a building`);
      for (const l of lines) {
        for (const f of l.fixed) if (toSegment(m.x, m.y, f.x0, f.y0, f.x1, f.y1) < JET_BRIDGE.linkHalf + RADIUS) faults.push(`${m.stand}'s mast under ${l.stand}'s walkway`);
        if (Math.hypot(m.x - l.end.x0, m.y - l.end.y0) < 2 + RADIUS) faults.push(`${m.stand}'s mast in ${l.stand}'s rotunda`);
      }
      if (fromRoads(m.x, m.y) < MAST_CLEAR.road) faults.push(`${m.stand}'s mast on a road`);
      if (fromRails(m.x, m.y) < RAIL_CLEAR) faults.push(`${m.stand}'s mast under a railway`);
    }
    expect(faults.slice(0, 8)).toEqual([]);
    // And the beacon, on open ground of the airport.
    expect(beacons.length).toBe(1);
    const [b] = beacons;
    expect(layout.land.airport.some((p) => inside(p.outer, b.x, b.y))).toBe(true);
    expect(rings.every((r) => ringReach(r, b.x, b.y) >= BEACON_CLEAR.building)).toBe(true);
    expect(fromRoads(b.x, b.y)).toBeGreaterThanOrEqual(BEACON_CLEAR.way);
    expect(fromRails(b.x, b.y)).toBeGreaterThanOrEqual(BEACON_CLEAR.way);
    // Off the lines aircraft follow, onto their stands too, and away from the stands.
    for (const e of airfield.edges) for (let i = 2; i < e.pts.length; i += 2) expect(toSegment(b.x, b.y, e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1])).toBeGreaterThanOrEqual(BEACON_CLEAR.taxi);
    for (const st of airfield.stands) expect(Math.hypot(st.x - b.x, st.y - b.y)).toBeGreaterThanOrEqual(BEACON_CLEAR.stand);
    expect(fromTaxiways(b.x, b.y)).toBeGreaterThanOrEqual(60);
    expect(fromRunways(b.x, b.y)).toBeGreaterThanOrEqual(100);
  });

  it('lights the approach-slope units red nearer the runway and white beyond, the beacon in its head, and every floodlight outside the terminal', () => {
    const f = furniture();
    const lamps = airfieldLamps(f);
    expect(lamps.slopes.length).toBe(f.lights.length);
    const fromCentreline = (x: number, y: number): number => Math.min(...airfield.runways.map((r) => toSegment(x, y, r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y)));
    for (const red of lamps.slopes.filter((l) => l.red)) {
      // The rest of its row: the units within the row's length of it.
      const row = lamps.slopes.filter((l) => Math.hypot(l.x - red.x, l.y - red.y) < 30);
      expect(row.filter((l) => l.red).length, 'two red to a row').toBe(2);
      for (const white of row.filter((l) => !l.red)) expect(fromCentreline(white.x, white.y)).toBeGreaterThan(fromCentreline(red.x, red.y));
    }
    expect(lamps.slopes.filter((l) => l.red).length * 2).toBe(lamps.slopes.length);
    expect(lamps.beacons.map((b) => [b.x, b.y])).toEqual(f.beacons.map((b) => [b.x, b.y]));
    for (const b of lamps.beacons) expect(b.h).toBeLessThan(10.1);
    const rings = layout.terminals.buildings.map((t) => t.poly.outer);
    for (const l of lamps.floodlights) expect(Math.min(...rings.map((r) => ringReach(r, l.x, l.y))), 'outside the terminal').toBeGreaterThan(0.5);
  });

  it('hangs each docking display on the face of the terminal where the line of its stand meets it, looking down the stand', () => {
    const { displays } = furniture();
    const gates = airfield.stands.filter((s) => s.contact);
    expect(displays.length).toBeGreaterThan(gates.length * 0.8);
    for (const d of displays) {
      const s = gates.find((g) => g.id === d.stand)!;
      const c = Math.cos(s.heading);
      const sn = Math.sin(s.heading);
      const ahead = (d.x - s.x) * c + (d.y - s.y) * sn;
      const across = -(d.x - s.x) * sn + (d.y - s.y) * c;
      expect(ahead, `${d.stand} ahead of the aircraft`).toBeGreaterThan(9);
      expect(Math.abs(across), `${d.stand} on the stand's line`).toBeLessThanOrEqual(6.01);
      expect(Math.cos(d.facing - (s.heading + Math.PI)), `${d.stand} looking down the stand`).toBeCloseTo(1, 6);
      expect(Math.min(...layout.terminals.buildings.map((t) => ringReach(t.poly.outer, d.x, d.y))), `${d.stand} at the terminal's face`).toBeLessThan(1);
    }
  });
});
