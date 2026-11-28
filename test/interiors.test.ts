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
import { EDGE, InnerWalls, SIZE, insidePolygon, type Fitting, type FittingKind } from '../src/sim/terminal/fittings.ts';
import { ACT, POSE, ROLE } from '../src/sim/terminal/people.ts';
import { FLOOR } from '../src/sim/terminal/plan.ts';
import { ServiceQueue, type LineSpot } from '../src/sim/terminal/queue.ts';
import { loadLayoutFromDisk, repoRoot } from './helpers/layout.ts';
import { loadModelsFromDisk } from './helpers/models.ts';
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

  it("keeps everything within the terminals' walls as drawn: the furniture, carousels and seats, and wherever people stand, queue, crowd or walk on to", () => {
    const { t, f } = fitted();
    const buildings = layout.terminals.buildings.map((b) => b.poly);
    const inside = (x: number, y: number): boolean => buildings.some((poly) => insidePolygon(poly, x, y));
    const out: string[] = [];
    const judge = (what: string, x: number, y: number): void => {
      if (!inside(x, y)) out.push(`${what} at ${x.toFixed(1)},${y.toFixed(1)}`);
    };
    // Every corner of every footprint (shrunk a little: touching the wall is not through it).
    for (const i of f.items) for (const [x, y] of corners(i)) judge(i.kind, x, y);
    for (const c of f.carousels) for (const [x, y] of corners(c)) judge('carousel', x, y);
    for (let k = 0; k < f.seats.length; k += 3) judge('seat', f.seats[k], f.seats[k + 1]);
    for (const spots of f.claimSpots) for (let k = 0; k < spots.length; k += 3) judge('claim spot', spots[k], spots[k + 1]);
    for (const [, spots] of f.aisles) for (let k = 0; k < spots.length; k += 3) judge('shop spot', spots[k], spots[k + 1]);
    for (const rope of f.ropes) for (let k = 0; k < rope.pts.length; k += 2) judge('rope', rope.pts[k], rope.pts[k + 1]);
    const spot: LineSpot = { x: 0, y: 0, dx: 0, dy: 0 };
    for (const [id, queue] of t.queues) {
      const kind = t.plan.places[id].kind;
      for (const s of queue.servers) {
        judge(`${kind} server`, s.x, s.y);
        if (!Number.isNaN(s.exitX)) judge(`${kind} exit`, s.exitX, s.exitY);
      }
      // The line between its ropes, and a crowd of a hundred past them.
      for (let d = 0; d < queue.roped + 100 * 0.85; d += 0.3) {
        queue.spotAt(d, spot);
        judge(`${kind} line`, spot.x, spot.y);
      }
    }
    expect(out.slice(0, 10)).toEqual([]);
  });

  it("keeps the map's indoor walls and closed rooms: nobody walks in a closed room, and nothing set out where there is room stands across a wall", () => {
    const { t, f } = fitted();
    const walls = layout.terminals.walls ?? [];
    expect(walls.filter((w) => w.floor === 'departures').length).toBeGreaterThan(300);
    expect(walls.filter((w) => w.floor === 'arrivals').length).toBeGreaterThan(20);
    expect(t.plan.closed.length).toBeGreaterThan(100);
    const inner = new InnerWalls(walls, t.plan.closed);
    // The floors people walk leave the closed rooms out.
    const open: string[] = [];
    t.plan.grids.forEach((g, floor) => {
      const rooms = t.plan.closed.filter((r) => (r.floor === 'arrivals') === (floor === FLOOR.arrivals));
      for (let c = 0; c < g.count; c += 1) if (rooms.some((r) => insidePolygon(r.poly, g.cx[c], g.cy[c]))) open.push(`floor ${floor} at ${g.cx[c]},${g.cy[c]}`);
    });
    expect(open.slice(0, 5)).toEqual([]);
    // Seats, and what is set out where there is room for it, stand clear of every wall; what
    // stands where its counter, lane, booth or gate says may yet meet one the map has there.
    const fixed = new Set<FittingKind>(['desk', 'backwall', 'booth', 'podium', 'reader', 'xray', 'bins', 'scanner', 'arch', 'board']);
    const across = f.items.filter((i) => !fixed.has(i.kind) && inner.across(i.floor, i.x, i.y, i.heading, i.length / 2 - 0.05, i.width / 2 - 0.05)).map((i) => `a ${i.kind} at ${i.x.toFixed(1)},${i.y.toFixed(1)}`);
    for (const g of f.groups) for (let k = g.first; k < g.first + g.count; k += 1) if (inner.across(g.floor, f.seats[k * 3], f.seats[k * 3 + 1], 0, 0.2, 0.2)) across.push(`a ${g.kind} seat at ${f.seats[k * 3].toFixed(1)},${f.seats[k * 3 + 1].toFixed(1)}`);
    expect(across.slice(0, 8)).toEqual([]);
  });

  it("raises no room's wall or glass through a seat or a piece of furniture", () => {
    const { t, f } = fitted();
    const level = (floor: number): number => (floor === FLOOR.arrivals ? 0 : 1);
    const toSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
      const [dx, dy] = [bx - ax, by - ay];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(px - ax - dx * t, py - ay - dy * t);
    };
    const walls: { ax: number; ay: number; bx: number; by: number; level: number }[] = [];
    for (const room of f.rooms) {
      const area = layout.terminals.areas[room.room];
      const actualLevel = level(room.floor);
      expect(actualLevel).toBe(t.plan.mappedFloors.rooms[room.room] === 'arrivals' ? 0 : 1);
      const ring = area.poly.outer;
      const n = ring.length / 2;
      room.edges.forEach((edge, i) => {
        if (edge !== EDGE.solid && edge !== EDGE.glass) return;
        const j = (i + 1) % n;
        walls.push({ ax: ring[i * 2], ay: ring[i * 2 + 1], bx: ring[j * 2], by: ring[j * 2 + 1], level: actualLevel });
      });
    }
    expect(walls.length).toBeGreaterThan(300);
    expect(walls.some((wall) => wall.level === 0)).toBe(true);
    const through: string[] = [];
    for (const g of f.groups) {
      for (let k = g.first; k < g.first + g.count; k += 1) {
        const [x, y] = [f.seats[k * 3], f.seats[k * 3 + 1]];
        if (walls.some((w) => w.level === level(g.floor) && toSegment(x, y, w.ax, w.ay, w.bx, w.by) < 0.3)) through.push(`a ${g.kind} seat at ${x.toFixed(1)},${y.toFixed(1)}`);
      }
    }
    for (const i of f.items) {
      const box = corners(i, 0.08);
      const inBox = (x: number, y: number): boolean => {
        const [c, s] = [Math.cos(i.heading), Math.sin(i.heading)];
        return Math.abs((x - i.x) * c + (y - i.y) * s) < i.length / 2 - 0.08 && Math.abs(-(x - i.x) * s + (y - i.y) * c) < i.width / 2 - 0.08;
      };
      for (const w of walls) {
        if (w.level !== level(i.floor) || box.every(([x, y]) => toSegment(x, y, w.ax, w.ay, w.bx, w.by) > Math.hypot(i.length, i.width))) continue;
        const steps = Math.max(2, Math.ceil(Math.hypot(w.bx - w.ax, w.by - w.ay) / 0.2));
        let crosses = false;
        for (let k = 0; k <= steps && !crosses; k += 1) crosses = inBox(w.ax + ((w.bx - w.ax) * k) / steps, w.ay + ((w.by - w.ay) * k) / steps);
        if (crosses) {
          through.push(`a ${i.kind} at ${i.x.toFixed(1)},${i.y.toFixed(1)}`);
          break;
        }
      }
    }
    expect(through.slice(0, 8)).toEqual([]);
  });

  it("stands nothing between a line's ropes: no seat, no furniture", () => {
    const { t, f } = fitted();
    const level = (floor: number): number => (floor === FLOOR.arrivals ? 0 : 1);
    const seatLevel = new Int8Array(f.seats.length / 3);
    for (const g of f.groups) seatLevel.fill(level(g.floor), g.first, g.first + g.count);
    const inside: string[] = [];
    for (const [id, queue] of t.queues) {
      const place = t.plan.places[id];
      const { x, y, heading, length, width } = queue.shape;
      const [ux, uy] = [Math.cos(heading), Math.sin(heading)];
      // Between the ropes: within the rectangle they run round, a little in from them.
      const within = (px: number, py: number): boolean => Math.abs((px - x) * ux + (py - y) * uy) < length / 2 - 0.1 && Math.abs(-(px - x) * uy + (py - y) * ux) < width / 2 - 0.1;
      for (let s = 0; s < seatLevel.length; s += 1) {
        if (seatLevel[s] === level(place.floor) && within(f.seats[s * 3], f.seats[s * 3 + 1])) inside.push(`a seat in the line of ${place.name ?? place.kind}`);
      }
      for (const i of f.items) {
        if (level(i.floor) === level(place.floor) && corners(i).some(([cx, cy]) => within(cx, cy))) inside.push(`a ${i.kind} in the line of ${place.name ?? place.kind}`);
      }
    }
    expect(inside.slice(0, 8)).toEqual([]);
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
    // Who stands inside a piece of furniture they have no business in: a traveller called to a
    // security lane in another lane's bins or belt, shop staff or a cleaner in a shelf or counter.
    const level = (floor: number): number => (floor === FLOOR.arrivals ? 0 : 1);
    const cells = new Map<string, Fitting[]>();
    const cellOf = (lv: number, x: number, y: number): string => `${lv}:${Math.floor(x / 10)},${Math.floor(y / 10)}`;
    for (const i of t.fittings.items) {
      const key = cellOf(level(i.floor), i.x, i.y);
      cells.set(key, [...(cells.get(key) ?? []), i]);
    }
    const standingIn = (floor: number, x: number, y: number): Fitting | null => {
      for (let dx = -10; dx <= 10; dx += 10) {
        for (let dy = -10; dy <= 10; dy += 10) {
          for (const i of cells.get(cellOf(level(floor), x + dx, y + dy)) ?? []) {
            const [c, sn] = [Math.cos(i.heading), Math.sin(i.heading)];
            if (Math.abs((x - i.x) * c + (y - i.y) * sn) < i.length / 2 - 0.1 && Math.abs(-(x - i.x) * sn + (y - i.y) * c) < i.width / 2 - 0.1) return i;
          }
        }
      }
      return null;
    };
    const misplaced: string[] = [];
    for (let k = 0; k < 75; k += 1) {
      sim.run(60);
      for (let id = 0; id < p.high; id += 1) {
        if (!p.alive[id]) continue;
        const served = p.role[id] === ROLE.passenger && p.act[id] === ACT.served;
        const working = (p.role[id] === ROLE.shop || p.role[id] === ROLE.cleaner) && p.act[id] === ACT.wait;
        if (!served && !working) continue;
        const i = standingIn(p.floor[id], p.x[id], p.y[id]);
        if (i && (served ? i.kind === 'xray' || i.kind === 'bins' : i.kind !== 'board')) misplaced.push(`${served ? 'a traveller called to a lane' : 'staff at a shop'} in a ${i.kind} at ${p.x[id].toFixed(1)},${p.y[id].toFixed(1)}`);
      }
      for (const [id, q] of t.queues) if (t.plan.places[id].kind === 'holdroom') longestBoarding = Math.max(longestBoarding, q.line.length);
      for (let id = 0; id < p.high; id += 1) {
        if (!p.alive[id] || p.role[id] !== ROLE.passenger || p.speed[id] <= 1.46) continue;
        hurrying += 1;
        const visit = sim.airside.book.visits.get(p.visit[id]);
        if (!visit || sim.time < visit.etd - (doorsClose + hurryFrom) * 60) early += 1;
      }
    }
    return { t, p, longestBoarding, hurrying, early, misplaced };
  });

  it("puts nobody where they have no business: a traveller called to a lane not through the lanes beside it, nor shop staff or cleaners in the shelves", () => {
    expect(crowds().misplaced.slice(0, 8)).toEqual([]);
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

  it('puts nobody in a hat much wider than a head: seen from above, a crowd indoors is people, not umbrellas', () => {
    const index = JSON.parse(readFileSync(join(repoRoot, 'public', 'models', 'index.json'), 'utf8')) as { models: { id: string; role: string }[] };
    const characters = loadModelsFromDisk(index.models.filter((m) => m.role === 'character').map((m) => m.id));
    expect(characters.size).toBeGreaterThan(20);
    const wide: string[] = [];
    for (const [id, model] of characters) {
      // Every colour of it: a hat's colour slots are each named for it.
      const hat = new Set((model.info.parts ?? []).flatMap((part, k) => (part === 'hat' ? [k] : [])));
      if (!hat.size) continue;
      const position = model.geometry.getAttribute('position');
      const slot = model.geometry.getAttribute('slot');
      let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < position.count; i += 1) {
        if (!hat.has(slot.getX(i))) continue;
        [x0, x1, z0, z1] = [Math.min(x0, position.getX(i)), Math.max(x1, position.getX(i)), Math.min(z0, position.getZ(i)), Math.max(z1, position.getZ(i))];
      }
      if (Math.max(x1 - x0, z1 - z0) > 0.45) wide.push(`${id}: a hat ${Math.max(x1 - x0, z1 - z0).toFixed(2)} m across`);
    }
    expect(wide).toEqual([]);
  });

  it('keeps a crowd past its ropes to the floor there is, each of its people in a place of their own', () => {
    // Walls behind the line and to one side of it.
    const standable = (x: number, y: number): boolean => x > -16 && y < 5;
    const queue = new ServiceQueue({ x: 0, y: 0, heading: 0, length: 12, width: 6 }, [{ x: 8, y: 0 }], standable);
    const spot: LineSpot = { x: 0, y: 0, dx: 0, dy: 0 };
    const pts: [number, number][] = [];
    // Sixty, one behind another, as close as a line's people stand (see People.room).
    for (let d = queue.roped + 0.5; d < queue.roped + 0.5 + 60 * 0.85 * 0.77; d += 0.85 * 0.77) {
      queue.spotAt(d, spot);
      expect(standable(spot.x, spot.y), `${spot.x.toFixed(1)},${spot.y.toFixed(1)}`).toBe(true);
      pts.push([spot.x, spot.y]);
    }
    let closest = Infinity;
    for (let i = 0; i < pts.length; i += 1) for (let j = i + 1; j < pts.length; j += 1) closest = Math.min(closest, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    expect(closest).toBeGreaterThan(0.4);
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
