// The jet bridges as mapped, from each terminal door out to its stand. All but the last length of
// each are the fixed walkway: Polyfork's jet bridge's fixed link, tiled along the mapped line, on
// its post at each bend, to the rotunda on its pedestal where the moving tunnel turns. The last
// length telescopes out to the aircraft's door and is drawn as it moves by
// src/render/dynamic/bridge-layer.ts. tools/models/polyfork.ts cuts the bridge into these parts.
// Without the models, each length is a box on a post.

import * as THREE from 'three';
import type { Layout } from '../../shared/layout.ts';
import { MeshBuilder, box, rgb } from '../builder.ts';
import { flatMaterial, propInstances, type Models } from '../models/library.ts';
import { solidMesh } from './common.ts';

export const BRIDGE_FLOOR = 4.1;
export const BRIDGE_ROOF = 6.9;
export const BRIDGE_TUNNEL = rgb(0xcfd3d6);
export const BRIDGE_STEEL = rgb(0x8a9097);

/**
 * Where the parts of Polyfork's jet bridge are, metres along its length (the model's x: the
 * terminal's end at -16, the cab's face at the aircraft door at +16) and up from the ground. The
 * tests hold these to the models (test/bridges.test.ts).
 */
export const JET_BRIDGE = {
  /** The fixed link, from its end at the terminal to its end inside the rotunda, and half its width. */
  link: [-16, -9.3],
  linkHalf: 1.3,
  /** The middle of the post under the link. */
  post: -14.2,
  /** The middle of the rotunda, which the tunnel turns on, and how far it reaches round from there. */
  rotunda: -8,
  rotundaReach: 2.6,
  /** The telescoping tunnel: its back inside the rotunda, its front inside the cab's drum. */
  tunnel: [-6.62, 11.72],
  /** The middle of the cab's drum, which the cab turns on; the cab's face, which meets the door; its floor there. */
  drum: 12.8,
  door: 16,
  cabFloor: 3.2,
  /** The middle of the lift under the tunnel, and the bottom and top of its legs. */
  lift: 10.2,
  legs: [1.3, 2.28],
} as const;

/** Metres the end of a bridge pulls back from where it is mapped to, and the shortest it gets with the models (the rotunda and the cab's drum just clear). */
export const BRIDGE_RETRACT = 6;
export const BRIDGE_SHORTEST = 4.6;
/** Of its mapped length, how far a bridge's end reaches parked, with no aircraft at its stand. */
export const BRIDGE_PARKED = 0.5;

/**
 * How far along its mapped line the end of a bridge `mapped` metres long reaches when parked: half
 * of it, and at least BRIDGE_RETRACT short of where it is mapped to, but no shorter than `shortest`.
 */
export function parkedReach(mapped: number, shortest: number): number {
  return Math.min(mapped, Math.max(shortest, Math.min(mapped - BRIDGE_RETRACT, mapped * BRIDGE_PARKED)));
}
/** Metres between the rotunda and the terminal's glass. */
export const ROTUNDA_GAP = 0.3;

/** The parts of the bridge, by model id. */
export const BRIDGE_PARTS = {
  link: 'jet-bridge-link',
  post: 'jet-bridge-post',
  rotunda: 'jet-bridge-rotunda',
  tunnel: 'jet-bridge-tunnel',
  cab: 'jet-bridge-cab',
  wheels: 'jet-bridge-wheels',
  legs: 'jet-bridge-legs',
  lift: 'jet-bridge-lift',
} as const;

/** The last length of a stand's jet bridge, which reaches out to the aircraft door: drawn as it moves. */
export interface BridgeEnd {
  stand: string;
  /** Where it turns: the rotunda. */
  x0: number;
  y0: number;
  /** Where it ends as mapped. */
  x1: number;
  y1: number;
}

export interface Bridges {
  group: THREE.Group;
  /** The moving ends, for the bridge layer. */
  ends: BridgeEnd[];
}

/** One straight length of a mapped bridge, from its end nearer the terminal to the other. */
export interface Length {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  length: number;
  heading: number;
}

/** How near a point comes to any of some rings: 0 inside one. */
function fromRings(rings: readonly (readonly number[])[], x: number, y: number): number {
  let least = Infinity;
  for (const ring of rings) {
    let within = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [ax, ay, bx, by] = [ring[j], ring[j + 1], ring[i], ring[i + 1]];
      if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) within = !within;
      const [dx, dy] = [bx - ax, by - ay];
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      least = Math.min(least, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    if (within) return 0;
  }
  return least;
}

/**
 * Each stand's mapped bridge, from the terminal door out to the aircraft, as straight lengths of at
 * least half a metre: all but the last are the fixed walkway; the last moves, turning where it
 * starts, at the rotunda. The map draws some bridges the other way round; without a door, the end
 * nearer where the nose stops is the aircraft's. Where the map turns the end at the terminal's
 * glass, or inside it, the walkway comes out along the end's line until the rotunda clears the
 * glass, if the end stays as long as the models need.
 */
export function bridgeLines(layout: Pick<Layout, 'airfield' | 'terminals'>): { stand: string; fixed: Length[]; end: Length }[] {
  const out: { stand: string; fixed: Length[]; end: Length }[] = [];
  const terminals = layout.terminals.buildings.map((b) => b.poly.outer);
  const clear = (x: number, y: number): boolean => fromRings(terminals, x, y) >= JET_BRIDGE.rotundaReach + ROTUNDA_GAP;
  for (const stand of layout.airfield.stands) {
    const mapped = stand.bridge;
    if (!mapped || mapped.length < 4) continue;
    const n = mapped.length;
    const [tx, ty] = stand.door ?? [Number.NaN, Number.NaN];
    const fromDoor = (k: number): number => Math.hypot(mapped[k] - tx, mapped[k + 1] - ty);
    const fromStop = (k: number): number => Math.hypot(mapped[k] - stand.x, mapped[k + 1] - stand.y);
    const reversed = stand.door ? fromDoor(n - 2) < fromDoor(0) : fromStop(0) < fromStop(n - 2);
    const line: number[] = [];
    for (let i = 0; i < n; i += 2) {
      const k = reversed ? n - 2 - i : i;
      line.push(mapped[k], mapped[k + 1]);
    }
    const lengths: Length[] = [];
    for (let i = 2; i < line.length; i += 2) {
      const [x0, y0, x1, y1] = [line[i - 2], line[i - 1], line[i], line[i + 1]];
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length >= 0.5) lengths.push({ x0, y0, x1, y1, length, heading: Math.atan2(y1 - y0, x1 - x0) });
    }
    let end = lengths.pop();
    if (!end) continue;
    if (!clear(end.x0, end.y0)) {
      const [ux, uy] = [Math.cos(end.heading), Math.sin(end.heading)];
      const most = end.length - BRIDGE_SHORTEST;
      let s = 0.5;
      while (s <= most && !clear(end.x0 + ux * s, end.y0 + uy * s)) s += 0.5;
      if (s <= most) {
        const [x, y] = [end.x0 + ux * s, end.y0 + uy * s];
        lengths.push({ x0: end.x0, y0: end.y0, x1: x, y1: y, length: s, heading: end.heading });
        end = { x0: x, y0: y, x1: end.x1, y1: end.y1, length: end.length - s, heading: end.heading };
      }
    }
    out.push({ stand: stand.id, fixed: lengths, end });
  }
  return out;
}

/** The angle between two headings, 0 to pi. */
function turn(a: number, b: number): number {
  const d = Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  return Math.min(d, Math.PI);
}

export function buildBridges(layout: Pick<Layout, 'airfield' | 'terminals'>, models: Models): Bridges {
  const group = new THREE.Group();
  group.name = 'jet-bridges';
  const ends: BridgeEnd[] = [];
  const link = models.get(BRIDGE_PARTS.link);
  const post = models.get(BRIDGE_PARTS.post);
  const rotunda = models.get(BRIDGE_PARTS.rotunda);
  const drawn = link && post && rotunda;
  const boxes = new MeshBuilder();
  const tiles: { x: number; y: number; h: number; facing: number; sx: number }[] = [];
  const posts: { x: number; y: number; h: number; facing: number }[] = [];
  const rotundas: { x: number; y: number; h: number; facing: number }[] = [];
  const [linkBack, linkFront] = JET_BRIDGE.link;
  const tileLength = linkFront - linkBack;
  for (const { stand, fixed: lengths, end } of bridgeLines(layout)) {
    ends.push({ stand, x0: end.x0, y0: end.y0, x1: end.x1, y1: end.y1 });
    if (!drawn) {
      for (const l of lengths) {
        box(boxes, (l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2, BRIDGE_FLOOR, BRIDGE_ROOF, l.length / 2 + 0.8, 1.55, l.heading, BRIDGE_TUNNEL, BRIDGE_TUNNEL);
        box(boxes, l.x1, l.y1, 0, BRIDGE_FLOOR, 0.45, 0.45, l.heading, BRIDGE_STEEL, BRIDGE_STEEL);
      }
      continue;
    }
    // The rotunda where the end turns, facing along the walkway that comes to it.
    const into = lengths.length ? lengths[lengths.length - 1].heading : end.heading;
    rotundas.push({ x: end.x0 - Math.cos(into) * JET_BRIDGE.rotunda, y: end.y0 - Math.sin(into) * JET_BRIDGE.rotunda, h: 0, facing: into - Math.PI / 2 });
    lengths.forEach((l, k) => {
      const ux = Math.cos(l.heading);
      const uy = Math.sin(l.heading);
      // Past a bend far enough to close its outside corner; into the rotunda as the model's link goes.
      const corner = (bend: number): number => JET_BRIDGE.linkHalf * Math.tan(Math.min(bend, 2.2) / 2) + 0.2;
      const from = k === 0 ? 0 : -corner(turn(lengths[k - 1].heading, l.heading));
      const last = k === lengths.length - 1;
      const to = last ? l.length - (JET_BRIDGE.rotunda - linkFront) : l.length + corner(turn(l.heading, lengths[k + 1].heading));
      const span = to - from;
      if (span > 0.5) {
        // Whole links end to end, each stretched a little to fit.
        const count = Math.max(1, Math.round(span / tileLength));
        const each = span / count;
        const sx = each / tileLength;
        for (let t = 0; t < count; t += 1) {
          const origin = from + t * each - linkBack * sx;
          tiles.push({ x: l.x0 + ux * origin, y: l.y0 + uy * origin, h: 0, facing: l.heading - Math.PI / 2, sx });
        }
      }
      if (!last) posts.push({ x: l.x1 - ux * JET_BRIDGE.post, y: l.y1 - uy * JET_BRIDGE.post, h: 0, facing: l.heading - Math.PI / 2 });
    });
  }
  if (drawn) {
    const material = flatMaterial();
    const parts = [propInstances(link, material, tiles, 'jet-bridge-links'), propInstances(post, material, posts, 'jet-bridge-posts'), propInstances(rotunda, material, rotundas, 'jet-bridge-rotundas')];
    for (const mesh of parts) {
      mesh.castShadow = true;
      group.add(mesh);
    }
  } else {
    group.add(solidMesh(boxes, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }), 'jet-bridges'));
  }
  return { group, ends };
}
