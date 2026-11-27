// The terminals furnished and peopled as an airport is: the owner's report of 2026-11-26 (no
// seats, belts, luggage or shops to be seen; lines too neat to be natural; the interior bare) as
// a class. Every activity the simulation runs has the furniture it needs, standing on the floor,
// nothing standing in anything else, drawn by models of the sizes the simulation lays out; and
// the crowds are not machine-made: no line keeps one spacing or one centreline, no overflow is a
// grid, people waiting at their gates sit in real seats, boarding goes by groups, and travellers
// pull their bags until they check them and after they collect them. See
// docs/learning/defect-register.md. Bound: the drawing itself is judged by the captures of
// `npm run visual`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_OF } from '../src/render/static/interiors.ts';
import { CONFIG } from '../src/sim/config.ts';
import { Sim } from '../src/sim/sim.ts';
import { SIZE, insidePolygon, type Fitting, type FittingKind } from '../src/sim/terminal/fittings.ts';
import { ACT, POSE, ROLE } from '../src/sim/terminal/people.ts';
import { FLOOR } from '../src/sim/terminal/plan.ts';
import { ServiceQueue, type LineSpot } from '../src/sim/terminal/queue.ts';
import { loadLayoutFromDisk, repoRoot } from './helpers/layout.ts';
import { once } from './helpers/once.ts';

const layout = loadLayoutFromDisk();

/** Corners of a fitting's footprint, shrunk a little so that things standing side by side do not count as touching. */
function corners(f: { x: number; y: number; heading: number; length: number; width: number }, shrink = 0.06): [number, number][] {
  const ux = Math.cos(f.heading);
  const uy = Math.sin(f.heading);
  const l = Math.max(0.01, f.length / 2 - shrink);
  const w = Math.max(0.01, f.width / 2 - shrink);
  return [[l, w], [-l, w], [-l, -w], [l, -w]].map(([a, b]) => [f.x + ux * a - uy * b, f.y + uy * a + ux * b] as [number, number]);
}

/** Whether two convex outlines overlap, by separating axes. */
function overlap(a: [number, number][], b: [number, number][]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 1) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const nx = y1 - y0;
      const ny = x0 - x1;
      const project = (p: [number, number][]): [number, number] => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [x, y] of p) {
          const d = x * nx + y * ny;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return [lo, hi];
      };
      const [a0, a1] = project(a);
      const [b0, b1] = project(b);
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

describe('the terminals, furnished', () => {
  const fitted = once(() => {
    const t = new Sim(layout, { seed: 7, startTime: 6.5 * 3600, people: true }).terminals!;
    return { t, f: t.fittings, places: t.plan.places };
  });
  const byKind = (kind: FittingKind): Fitting[] => fitted().f.items.filter((i) => i.kind === kind);
  const near = (list: readonly Fitting[], x: number, y: number, reach: number): boolean => list.some((i) => Math.hypot(i.x - x, i.y - y) <= reach);

  it('has a desk for every check-in server, a lane for every security server, a booth for every passport server and a desk at every gate', () => {
    const { t, places } = fitted();
    const desks = byKind('desk');
    const xrays = byKind('xray');
    const scanners = [...byKind('scanner'), ...byKind('arch')];
    const booths = byKind('booth');
    const podiums = byKind('podium');
    let servers = 0;
    for (const [id, queue] of t.queues) {
      const place = places[id];
      for (const s of queue.servers) {
        servers += 1;
        if (place.kind === 'checkin') expect(near(desks, s.x, s.y, 2.6), `${place.name}: a desk`).toBe(true);
        if (place.kind === 'checkpoint') {
          expect(near(xrays, s.x, s.y, 4.2), `${place.name}: an x-ray belt`).toBe(true);
          expect(near(scanners, s.x, s.y, 3.6), `${place.name}: a scanner or arch`).toBe(true);
        }
        if (place.kind === 'customs') expect(near(booths, s.x, s.y, 2.6), `${place.name}: a booth`).toBe(true);
      }
      // Its own gate desk, or one it shares with the gate beside it.
      if (place.kind === 'holdroom') expect(near(podiums, place.x, place.y, 8), `${place.name}: a gate desk`).toBe(true);
    }
    expect(servers).toBeGreaterThan(500);
  });

  it('gives nearly every gate seats of its own, and every gate seats within a short walk', () => {
    const { t, f } = fitted();
    const gates = [...t.plan.holdroom.values()];
    const own = gates.filter((g) => (f.groupsOf.get(g.id) ?? []).some((i) => f.groups[i].kind === 'gate'));
    expect(own.length).toBeGreaterThanOrEqual(Math.ceil(gates.length * 0.95));
    const seatAt = f.groups.filter((g) => g.kind === 'gate').map((g) => [f.seats[g.first * 3], f.seats[g.first * 3 + 1]] as const);
    for (const g of gates) expect(seatAt.some(([x, y]) => Math.hypot(x - g.x, y - g.y) < 40), `${g.name}: seats near`).toBe(true);
    // Enough seats for most of a full aircraft's people at each gate, in all.
    const seats = f.groups.filter((g) => g.kind === 'gate').reduce((n, g) => n + g.count, 0);
    expect(seats).toBeGreaterThan(gates.length * 80);
  });

  it('has carousels in every claim hall, with room round them to wait', () => {
    const { t, f, places } = fitted();
    const claims = new Set([...t.plan.claim.values()].flatMap((c) => [c.domestic.id, c.international.id]));
    for (const id of claims) {
      const list = f.carouselsOf.get(id) ?? [];
      expect(list.length, places[id].name).toBeGreaterThan(0);
      for (const c of list) expect(f.claimSpots[c].length / 3).toBeGreaterThan(20);
    }
  });

  it('fits out the mapped shops, cafés and lounges', () => {
    const { f } = fitted();
    const inRoom = (kinds: FittingKind[], room: number): boolean => f.items.some((i) => kinds.includes(i.kind) && insidePolygon(layout.terminals.areas[room].poly, i.x, i.y));
    const walled = f.rooms.filter((r) => r.kind === 'shop' || r.kind === 'food' || r.kind === 'lounge');
    expect(walled.length).toBeGreaterThan(70);
    let furnished = 0;
    for (const r of walled) {
      const kinds: FittingKind[] = r.kind === 'shop' ? ['shelf', 'gondola', 'newsstand', 'till'] : r.kind === 'food' ? ['counter', 'kitchen', 'table'] : ['lowtable', 'counter'];
      if (inRoom(kinds, r.room)) furnished += 1;
    }
    expect(furnished).toBeGreaterThanOrEqual(Math.ceil(walled.length * 0.9));
    expect(f.groups.filter((g) => g.kind === 'food').length).toBeGreaterThan(100);
  });

  it('stands everything on the floor, nothing inside anything else, and no seat inside furniture', () => {
    const { t, f } = fitted();
    // On the floor: inside a terminal building, where the walking grid's cells may not reach right to the walls.
    const grids = t.plan.grids;
    const buildings = layout.terminals.buildings.map((b) => b.poly);
    const onFloor = (floor: number, x: number, y: number): boolean =>
      (floor === FLOOR.arrivals ? [grids[0]] : [grids[1], grids[2]]).some((g) => g.cellAt(x, y) >= 0) || buildings.some((poly) => insidePolygon(poly, x, y));
    const solid = f.items.filter((i) => i.kind !== 'board' && i.kind !== 'reader');
    const off = solid.filter((i) => !onFloor(i.floor, i.x, i.y));
    expect(off.length).toBeLessThanOrEqual(Math.ceil(solid.length * 0.01));
    const buckets = new Map<string, number[]>();
    const key = (x: number, y: number): string => `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
    solid.forEach((i, n) => {
      const list = buckets.get(key(i.x, i.y)) ?? [];
      list.push(n);
      buckets.set(key(i.x, i.y), list);
    });
    const clashes: string[] = [];
    solid.forEach((a, n) => {
      const ca = corners(a);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const m of buckets.get(`${Math.floor(a.x / 10) + dx},${Math.floor(a.y / 10) + dy}`) ?? []) {
            const b = solid[m];
            if (m <= n || a.floor === FLOOR.arrivals !== (b.floor === FLOOR.arrivals)) continue;
            if (overlap(ca, corners(b))) clashes.push(`${a.kind} at ${a.x.toFixed(1)},${a.y.toFixed(1)} and ${b.kind} at ${b.x.toFixed(1)},${b.y.toFixed(1)}`);
          }
        }
      }
    });
    expect(clashes.slice(0, 10)).toEqual([]);
    // Seats: none inside a fitting but the café table sets, whose chairs they are.
    const hard = solid.filter((i) => i.kind !== 'table' && i.kind !== 'lowtable');
    const inside: string[] = [];
    for (let s = 0; s < f.seats.length / 3; s += 1) {
      const [x, y] = [f.seats[s * 3], f.seats[s * 3 + 1]];
      for (const i of hard) {
        if (Math.abs(i.x - x) > 8 || Math.abs(i.y - y) > 8) continue;
        if (overlap(corners(i), corners({ x, y, heading: 0, length: 0.2, width: 0.2 }, 0))) inside.push(`seat ${s} in a ${i.kind}`);
      }
    }
    expect(inside.slice(0, 10)).toEqual([]);
  });

  it('is drawn with models of the sizes it is laid out at', () => {
    const index = JSON.parse(readFileSync(join(repoRoot, 'public', 'models', 'index.json'), 'utf8')) as { models: { id: string; size: [number, number, number] }[] };
    const sizeOf = new Map(index.models.map((m) => [m.id, m.size]));
    for (const [kind, id] of Object.entries(MODEL_OF) as [FittingKind, string | null][]) {
      if (!id || kind === 'gondola' || kind === 'trolleys') continue;
      const size = sizeOf.get(id);
      expect(size, `${kind}: ${id} is in the library`).toBeDefined();
      const [length, width, height] = SIZE[kind];
      // Across, deep and high: the model's x, z and y.
      expect(Math.abs(size![0] - length) / length, `${kind} length`).toBeLessThan(0.02);
      expect(Math.abs(size![2] - width) / width, `${kind} depth`).toBeLessThan(0.02);
      expect(Math.abs(size![1] - height) / height, `${kind} height`).toBeLessThan(0.02);
    }
  });
});

describe('crowds that are not machine-made', () => {
  const crowds = once(() => {
    const sim = new Sim(layout, { seed: 7, startTime: 6.5 * 3600, people: true });
    const t = sim.terminals!;
    const p = t.people;
    let longestBoarding = 0;
    /** Passengers seen going faster than anyone walks, and of them those whose doors were not about to close. */
    let hurrying = 0;
    let early = 0;
    const { doorsClose, hurryFrom } = CONFIG.turnaround;
    for (let k = 0; k < 75; k += 1) {
      sim.run(60);
      for (const [id, q] of t.queues) if (t.plan.places[id].kind === 'holdroom') longestBoarding = Math.max(longestBoarding, q.line.length);
      for (let id = 0; id < p.high; id += 1) {
        if (!p.alive[id] || p.role[id] !== ROLE.passenger || p.speed[id] <= 1.46) continue;
        hurrying += 1;
        const visit = sim.airside.book.visits.get(p.visit[id]);
        if (!visit || sim.time < visit.etd - (doorsClose + hurryFrom) * 60) early += 1;
      }
    }
    return { t, p, longestBoarding, hurrying, early };
  });

  it('keeps no line to one spacing, one centreline or one way of facing', () => {
    const { t, p } = crowds();
    let lines = 0;
    for (const queue of t.queues.values()) {
      const line = queue.line;
      if (line.length < 12) continue;
      lines += 1;
      const gaps: number[] = [];
      const off: number[] = [];
      const turn: number[] = [];
      for (let i = 1; i + 1 < line.length && i < 40; i += 1) {
        const [a, b, c] = [line[i - 1], line[i], line[i + 1]];
        gaps.push(Math.hypot(p.tx[b] - p.tx[a], p.ty[b] - p.ty[a]));
        // How far each stands off the line through the people either side of them.
        const dx = p.tx[c] - p.tx[a];
        const dy = p.ty[c] - p.ty[a];
        const len = Math.hypot(dx, dy) || 1;
        off.push(Math.abs((p.tx[b] - p.tx[a]) * dy - (p.ty[b] - p.ty[a]) * dx) / len);
        const ahead = Math.atan2(p.ty[a] - p.ty[b], p.tx[a] - p.tx[b]);
        turn.push(Math.abs(Math.atan2(Math.sin(p.facing[b] - ahead), Math.cos(p.facing[b] - ahead))));
      }
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
      expect(sd / mean, 'spacing varies').toBeGreaterThan(0.1);
      expect(off.reduce((s, o) => s + o, 0) / off.length, 'off the centreline').toBeGreaterThan(0.05);
      const meanTurn = turn.reduce((s, a) => s + a, 0) / turn.length;
      expect(meanTurn, 'facing varies').toBeGreaterThan(0.05);
      expect(meanTurn, 'but mostly faces the front').toBeLessThan(1.2);
    }
    expect(lines).toBeGreaterThan(0);
  });

  it('lets a line past its ropes into a loose crowd, not a grid', () => {
    const queue = new ServiceQueue({ x: 0, y: 0, heading: 0, length: 12, width: 6 }, [{ x: 8, y: 0 }]);
    const spot: LineSpot = { x: 0, y: 0, dx: 0, dy: 0 };
    const pts: [number, number][] = [];
    for (let d = queue.roped + 0.5; d < queue.roped + 150; d += 0.85) {
      queue.spotAt(d, spot);
      pts.push([spot.x, spot.y]);
    }
    let closest = Infinity;
    for (let i = 0; i < pts.length; i += 1) for (let j = i + 1; j < pts.length; j += 1) closest = Math.min(closest, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    expect(closest).toBeGreaterThan(0.4);
    // On a grid, people share a handful of distances back from the ropes; in a crowd, hardly any.
    const rows = new Set(pts.map(([x]) => Math.round(x * 10)));
    expect(rows.size).toBeGreaterThan(pts.length * 0.4);
  });

  it('sits people waiting at their gates in real seats, one party to a seat, and boards them by groups', () => {
    const { t, p, longestBoarding } = crowds();
    let waiting = 0;
    let sitting = 0;
    const held = new Map<number, number>();
    for (let id = 0; id < p.high; id += 1) {
      if (!p.alive[id] || p.role[id] !== ROLE.passenger) continue;
      if (p.pose[id] === POSE.sitting) {
        const seat = p.seat[id];
        expect(seat).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(p.x[id] - t.fittings.seats[seat * 3], p.y[id] - t.fittings.seats[seat * 3 + 1])).toBeLessThan(0.05);
        for (let k = 0; k < p.size[id]; k += 1) {
          expect(held.has(seat + k), 'one party to a seat').toBe(false);
          held.set(seat + k, id);
        }
      }
      if (p.floor[id] === FLOOR.airside && p.act[id] === ACT.wait) {
        waiting += 1;
        if (p.pose[id] === POSE.sitting) sitting += 1;
      }
    }
    expect(waiting).toBeGreaterThan(300);
    expect(sitting / waiting).toBeGreaterThan(0.5);
    expect(longestBoarding).toBeGreaterThan(0);
    // A boarding group of a wide-body is some forty parties; everyone at once was seventy and more.
    expect(longestBoarding).toBeLessThanOrEqual(55);
  });

  it('has passengers run for gates whose doors are about to close, and nobody else', () => {
    const { t, hurrying, early } = crowds();
    // Walking is 1.1 to 1.45 m/s; hurrying is a run, or with children a brisk walk.
    expect(hurrying).toBeGreaterThan(0);
    expect(early).toBe(0);
    expect(t.stats.departing.hurried).toBeGreaterThan(0);
    expect(t.stats.departing.hurried).toBeLessThan(0.1 * t.stats.departing.boarded);
  });

  it('has travellers pull their bags until they check them in, and after they collect them', () => {
    const { p } = crowds();
    let before = 0;
    let after = 0;
    let airside = 0;
    for (let id = 0; id < p.high; id += 1) {
      if (!p.alive[id] || p.role[id] !== ROLE.passenger || !p.luggage[id]) continue;
      if (p.floor[id] === FLOOR.landside) before += 1;
      else if (p.floor[id] === FLOOR.arrivals) after += 1;
      else airside += 1;
    }
    expect(before).toBeGreaterThan(20);
    // Early in the day few arrivals have collected bags yet; some have.
    expect(after).toBeGreaterThan(0);
    expect(airside).toBe(0);
  });
});
