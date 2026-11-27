// Train routes from the mapped track. The map gives rail as loose pieces; a route is found by
// joining them end to end along the shortest way between the stopping points of its stations,
// keeping to the right-hand track so the two directions of a line do not share one.

import type { Rail, RailStation } from '../../shared/layout.ts';
import { Transit, makeRoute, type Stop } from './trains.ts';

type Kind = Rail['lines'][number]['kind'];

/** The sharpest a line may bend where two mapped pieces of track meet, radians: a switch is far gentler. */
const TURN_MOST = Math.PI / 3;

interface Piece {
  a: number;
  b: number;
  pts: number[];
  cum: number[];
  len: number;
}

interface Anchor {
  piece: number;
  /** Distance along the piece. */
  s: number;
  x: number;
  y: number;
  z: number;
}

/** The track of one kind of railway as a graph of pieces joined at their ends. */
class Track {
  readonly nodes: { x: number; y: number; z: number; pieces: number[] }[] = [];
  readonly pieces: Piece[] = [];

  constructor(rail: Rail, kind: Kind) {
    for (const line of rail.lines) {
      if (line.kind !== kind || line.pts.length < 6) continue;
      const pts = line.pts;
      const cum = [0];
      for (let i = 3; i < pts.length; i += 3) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]));
      const n = pts.length;
      const a = this.nodeAt(pts[0], pts[1], pts[2]);
      const b = this.nodeAt(pts[n - 3], pts[n - 2], pts[n - 1]);
      const id = this.pieces.length;
      this.pieces.push({ a, b, pts, cum, len: cum[cum.length - 1] });
      this.nodes[a].pieces.push(id);
      this.nodes[b].pieces.push(id);
    }
  }

  private nodeAt(x: number, y: number, z: number): number {
    for (let i = 0; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      if (Math.hypot(n.x - x, n.y - y) < 1.5 && Math.abs(n.z - z) < 3) return i;
    }
    this.nodes.push({ x, y, z, pieces: [] });
    return this.nodes.length - 1;
  }

  /** The point of the track nearest to (x, y), or null if none is within `reach`. */
  anchor(x: number, y: number, reach = 12): Anchor | null {
    let best: Anchor | null = null;
    let bestD = reach;
    this.pieces.forEach((piece, index) => {
      const p = piece.pts;
      for (let i = 3; i < p.length; i += 3) {
        const ax = p[i - 3];
        const ay = p[i - 2];
        const dx = p[i] - ax;
        const dy = p[i + 1] - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
        if (d >= bestD) continue;
        bestD = d;
        best = { piece: index, s: piece.cum[i / 3 - 1] + Math.sqrt(len2) * t, x: ax + dx * t, y: ay + dy * t, z: p[i - 1] + (p[i + 2] - p[i - 1]) * t };
      }
    });
    return best;
  }

  /** The stretch of a piece between two distances along it, as x, y, z triples; reversed if from is the greater. */
  private stretch(piece: Piece, from: number, to: number): number[] {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const at = (s: number): [number, number, number] => {
      let i = 1;
      while (i < piece.cum.length - 1 && piece.cum[i] < s) i += 1;
      const span = piece.cum[i] - piece.cum[i - 1] || 1;
      const t = (s - piece.cum[i - 1]) / span;
      const p = piece.pts;
      const k = (i - 1) * 3;
      return [p[k] + (p[k + 3] - p[k]) * t, p[k + 1] + (p[k + 4] - p[k + 1]) * t, p[k + 2] + (p[k + 5] - p[k + 2]) * t];
    };
    const out: number[] = [...at(lo)];
    for (let i = 0; i < piece.cum.length; i += 1) if (piece.cum[i] > lo + 0.05 && piece.cum[i] < hi - 0.05) out.push(piece.pts[i * 3], piece.pts[i * 3 + 1], piece.pts[i * 3 + 2]);
    out.push(...at(hi));
    if (to >= from) return out;
    const reversed: number[] = [];
    for (let i = out.length - 3; i >= 0; i -= 3) reversed.push(out[i], out[i + 1], out[i + 2]);
    return reversed;
  }

  /** The way a piece runs at one of its ends, as a unit vector pointing into the piece. */
  private outOf(piece: Piece, atA: boolean): [number, number] {
    const p = piece.pts;
    const n = p.length / 3;
    // The first point far enough along to give the direction, not a kink at the very end.
    for (let k = 1; k < n; k += 1) {
      const i = atA ? k * 3 : (n - 1 - k) * 3;
      const j = atA ? 0 : (n - 1) * 3;
      const dx = p[i] - p[j];
      const dy = p[i + 1] - p[j + 1];
      const d = Math.hypot(dx, dy);
      if (d > 3 || k === n - 1) return [dx / (d || 1), dy / (d || 1)];
    }
    return [1, 0];
  }

  /**
   * The shortest way along the track from one anchor to another, as x, y, z triples, with its
   * length. A train may set off either way from where it stands, but through a junction it keeps
   * going the way it was: from one branch of a switch it can go to the line the switch serves, not
   * back out along the other branch.
   */
  path(from: Anchor, to: Anchor): { pts: number[]; len: number } | null {
    if (from.piece === to.piece) return { pts: this.stretch(this.pieces[from.piece], from.s, to.s), len: Math.abs(to.s - from.s) };
    const start = this.pieces[from.piece];
    const goal = this.pieces[to.piece];
    // A state is a piece run to one of its ends: `${piece}>${a or b}`.
    const best = new Map<string, number>();
    const back = new Map<string, string | null>();
    const open: { key: string; d: number }[] = [];
    const reach = (key: string, d: number, prev: string | null): void => {
      if (d >= (best.get(key) ?? Infinity)) return;
      best.set(key, d);
      back.set(key, prev);
      open.push({ key, d });
    };
    reach(`${from.piece}>a`, from.s, null);
    reach(`${from.piece}>b`, start.len - from.s, null);
    let found: { key: string; d: number } | null = null;
    while (open.length) {
      let k = 0;
      for (let i = 1; i < open.length; i += 1) if (open[i].d < open[k].d) k = i;
      const { key, d } = open.splice(k, 1)[0];
      if (d > (best.get(key) ?? Infinity)) continue;
      if (found && d >= found.d) break;
      const [pieceText, end] = key.split('>');
      const piece = this.pieces[Number(pieceText)];
      const node = end === 'a' ? piece.a : piece.b;
      // Arriving at the node along this piece, heading the opposite way to the piece leaving it.
      const [ox, oy] = this.outOf(piece, end === 'a');
      for (const id of this.nodes[node].pieces) {
        if (id === Number(pieceText)) continue;
        const next = this.pieces[id];
        const leavesA = next.a === node;
        const [nx, ny] = this.outOf(next, leavesA);
        // Going on, not turning back: the way out is within TURN_MOST of straight ahead.
        if (-(ox * nx + oy * ny) < Math.cos(TURN_MOST)) continue;
        if (id === to.piece) {
          const total = d + (leavesA ? to.s : goal.len - to.s);
          if (!found || total < found.d) found = { key: `${id}<${leavesA ? 'a' : 'b'}|${key}`, d: total };
          continue;
        }
        reach(`${id}>${leavesA ? 'b' : 'a'}`, d + next.len, key);
      }
    }
    if (!found) return null;
    // Walk back from the goal piece to the start.
    const [arrival, last] = found.key.split('|');
    const entersA = arrival.endsWith('a');
    const tail = this.stretch(goal, entersA ? 0 : goal.len, to.s);
    const middle: number[][] = [];
    let key: string | null = last;
    let node = -1;
    while (key) {
      const [pieceText, end] = key.split('>');
      const id = Number(pieceText);
      const piece = this.pieces[id];
      const prev: string | null = back.get(key) ?? null;
      if (id === from.piece && prev === null) {
        node = end === 'a' ? start.a : start.b;
        break;
      }
      middle.push(this.stretch(piece, end === 'a' ? piece.len : 0, end === 'a' ? 0 : piece.len));
      key = prev;
    }
    const head = this.stretch(start, from.s, node === start.a ? 0 : start.len);
    const pts: number[] = [...head];
    const append = (part: number[]): void => {
      for (let i = 0; i < part.length; i += 3) {
        const n = pts.length;
        if (n && Math.hypot(part[i] - pts[n - 3], part[i + 1] - pts[n - 2]) < 0.05) continue;
        pts.push(part[i], part[i + 1], part[i + 2]);
      }
    };
    for (let i = middle.length - 1; i >= 0; i -= 1) append(middle[i]);
    append(tail);
    return { pts, len: found.d };
  }

  /** Ends of track that lead nowhere, as anchors. */
  deadEnds(): Anchor[] {
    const out: Anchor[] = [];
    this.nodes.forEach((n, index) => {
      if (n.pieces.length !== 1) return;
      const piece = this.pieces[n.pieces[0]];
      out.push({ piece: n.pieces[0], s: piece.a === index ? 0 : piece.len, x: n.x, y: n.y, z: n.z });
    });
    return out;
  }
}

const anchorKey = (a: Anchor): string => `${a.piece}:${Math.round(a.s)}`;

/**
 * A closed route calling at the stations in the order given. Each station has a stopping point
 * on each track; of all the ways of choosing one per call, the shortest round trip is taken,
 * never using a stopping point in `taken` (another line's), and never the same one twice when a
 * station is called at both on the way out and on the way back.
 */
function loopRoute(track: Track, id: string, calls: RailStation[], taken: Set<string>, dwell: number, speed: number, cars: number, carLength: number): { route: ReturnType<typeof makeRoute>; used: Set<string> } | null {
  const options: Anchor[][] = [];
  const kept: RailStation[] = [];
  for (const station of calls) {
    const all = station.stops.map(([x, y]) => track.anchor(x, y)).filter((a): a is Anchor => a !== null);
    const free = all.filter((a) => !taken.has(anchorKey(a)));
    const usable = free.length ? free : all;
    if (!usable.length) continue;
    options.push(usable);
    kept.push(station);
  }
  const n = options.length;
  if (n < 2) return null;
  const lengths = new Map<string, number>();
  const between = (a: Anchor, b: Anchor): number => {
    const key = `${anchorKey(a)}>${anchorKey(b)}`;
    let len = lengths.get(key);
    if (len === undefined) {
      len = track.path(a, b)?.len ?? Infinity;
      lengths.set(key, len);
    }
    return len;
  };
  let best: Anchor[] | null = null;
  let bestLength = Infinity;
  const choice = new Array<number>(n).fill(0);
  const combinations = options.reduce((product, o) => product * o.length, 1);
  for (let c = 0; c < combinations; c += 1) {
    let rest = c;
    for (let i = 0; i < n; i += 1) {
      choice[i] = rest % options[i].length;
      rest = Math.floor(rest / options[i].length);
    }
    // A station called at twice is called at on a different track each time.
    let twice = false;
    for (let i = 0; i < n && !twice; i += 1) for (let j = i + 1; j < n; j += 1) if (kept[i] === kept[j] && options[i].length > 1 && anchorKey(options[i][choice[i]]) === anchorKey(options[j][choice[j]])) twice = true;
    if (twice) continue;
    let total = 0;
    for (let i = 0; i < n && total < bestLength; i += 1) total += between(options[i][choice[i]], options[(i + 1) % n][choice[(i + 1) % n]]);
    if (total < bestLength) {
      bestLength = total;
      best = options.map((o, i) => o[choice[i]]);
    }
  }
  if (!best || bestLength === Infinity) return null;
  const pts: number[] = [];
  const stops: Stop[] = [];
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const leg = track.path(best[i], best[(i + 1) % n])!;
    stops.push({ name: kept[i].name, s: total, dwell });
    for (let k = i === 0 ? 0 : 3; k < leg.pts.length; k += 3) pts.push(leg.pts[k], leg.pts[k + 1], leg.pts[k + 2]);
    total += leg.len;
  }
  return { route: makeRoute(id, 'airtrain', pts, true, stops, speed, cars, carLength), used: new Set(best.map(anchorKey)) };
}

/** Every train service on the map, with its trains on the line. */
export function buildTransit(rail: Rail): Transit {
  const transit = new Transit();

  // ---- AirTrain: the Red Line round the terminals, the Blue Line round them and out to the car parks.
  const airtrain = new Track(rail, 'airtrain');
  const stations = rail.stations.filter((s) => s.kind === 'airtrain');
  const outlying = ['West Field Road', 'Rental Car Center', 'Long Term Parking'];
  const ring = stations.filter((s) => !outlying.includes(s.name));
  if (ring.length >= 3) {
    const cx = ring.reduce((sum, s) => sum + s.x, 0) / ring.length;
    const cy = ring.reduce((sum, s) => sum + s.y, 0) / ring.length;
    const counter = [...ring].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
    const clockwise = [...counter].reverse();
    const out = outlying.map((name) => stations.find((s) => s.name === name)).filter((s): s is RailStation => Boolean(s));
    /** The two lines with the Red Line going round one way and the Blue Line the other, on the track the Red leaves free. */
    const lines = (redWay: RailStation[], blueWay: RailStation[]) => {
      const red = loopRoute(airtrain, 'AirTrain Red Line', redWay, new Set(), 26, 12.5, 2, 11.8);
      if (!out.length) return { red, blue: null, length: red?.route.total ?? Infinity };
      // Leave the ring at the station nearest the first outlying one, and come back to it.
      let nearest = 0;
      blueWay.forEach((s, i) => {
        if (Math.hypot(s.x - out[0].x, s.y - out[0].y) < Math.hypot(blueWay[nearest].x - out[0].x, blueWay[nearest].y - out[0].y)) nearest = i;
      });
      const order = [...blueWay.slice(nearest + 1), ...blueWay.slice(0, nearest + 1), ...out, ...out.slice(0, -1).reverse()];
      const blue = loopRoute(airtrain, 'AirTrain Blue Line', order, red ? red.used : new Set(), 26, 12.5, 3, 11.8);
      return { red, blue, length: (red?.route.total ?? Infinity) + (blue?.route.total ?? Infinity) };
    };
    // Which way round each goes is settled by the junctions: where the line to the car parks meets
    // the ring, a train can only turn one way onto it. Of the two, the pair with the shorter lines.
    const options = [lines(counter, clockwise), lines(clockwise, counter)];
    const { red, blue } = options[0].length <= options[1].length ? options[0] : options[1];
    if (red) transit.addTrains(transit.addRoute(red.route), 4);
    if (blue) transit.addTrains(transit.addRoute(blue.route), 5);
  }

  // ---- BART: from where the line leaves the map to each of its two termini here, and back.
  const bart = new Track(rail, 'bart');
  const bartEnds = bart.deadEnds().filter((e) => e.z < -8);
  for (const station of rail.stations.filter((s) => s.kind === 'bart')) {
    let best: { pts: number[]; len: number } | null = null;
    for (const [x, y] of station.stops) {
      const platform = bart.anchor(x, y);
      if (!platform) continue;
      for (const end of bartEnds) {
        const path = bart.path(end, platform);
        if (path && (!best || path.len < best.len)) best = path;
      }
    }
    if (!best) continue;
    const route = makeRoute(`BART to ${station.name}`, 'bart', best.pts, false, [{ name: station.name, s: best.len - 1, dwell: 150 }], 24, 9, 21.3);
    transit.addTrains(transit.addRoute(route), 1);
  }

  // ---- Caltrain: straight through on each track, calling where it has platforms.
  const caltrain = new Track(rail, 'caltrain');
  const ends = caltrain.deadEnds();
  const used = new Set<number>();
  for (const end of ends) {
    if (used.has(end.piece)) continue;
    let far: { anchor: Anchor; path: { pts: number[]; len: number } } | null = null;
    for (const other of ends) {
      if (other === end) continue;
      const path = caltrain.path(end, other);
      if (path && (!far || path.len > far.path.len)) far = { anchor: other, path };
    }
    if (!far) continue;
    used.add(end.piece);
    used.add(far.anchor.piece);
    const stops: Stop[] = [];
    for (const station of rail.stations.filter((s) => s.kind === 'caltrain')) {
      let nearest: { s: number; distance: number } | null = null;
      for (const [x, y] of station.stops) {
        const at = locateOn(far.path.pts, x, y);
        if (at.distance < 6 && (!nearest || at.distance < nearest.distance)) nearest = at;
      }
      if (nearest) stops.push({ name: station.name, s: nearest.s, dwell: 50 });
    }
    const route = makeRoute(`Caltrain ${transit.routes.length}`, 'caltrain', far.path.pts, false, stops, 27, 6, 26);
    transit.addTrains(transit.addRoute(route), 1);
  }
  transit.findSharedTrack();
  return transit;
}

/** Distance along a line of x, y, z triples of the point nearest to (x, y). */
function locateOn(pts: readonly number[], x: number, y: number): { s: number; distance: number } {
  let best = { s: 0, distance: Infinity };
  let run = 0;
  for (let i = 3; i < pts.length; i += 3) {
    const ax = pts[i - 3];
    const ay = pts[i - 2];
    const dx = pts[i] - ax;
    const dy = pts[i + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
    if (d < best.distance) best = { s: run + len * t, distance: d };
    run += len;
  }
  return best;
}
