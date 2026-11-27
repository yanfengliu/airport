// The airfield's furniture at its runways, from Polyfork's airport kit, placed from the mapped
// runways: a windsock beside each runway end, its sock streaming downwind in the prevailing
// west-north-west wind, and the four light units of the approach-slope indicator on the left of each
// landing direction, facing down the approach. Each stands its usual distance in from the landing
// threshold, or moved along the runway as little as keeps it clear of the taxiways and the airfield's
// service roads, or where the left has no room, on the right, as a real one is; where neither has,
// it is left out. Placed once; without the models, nothing.

import * as THREE from 'three';
import type { Airfield, Roads } from '../../shared/layout.ts';
import { flatMaterial, propInstances, type Models } from '../models/library.ts';

/** Metres into the runway from the landing threshold, and out from its edge, of each kind: the windsock's the first of these with room. */
const WINDSOCK_IN = 300;
const WINDSOCK_OUT = [60, 45, 80, 100, 130];
const PAPI_IN = 300;
const PAPI_OUT = 15;
const PAPI_SPACING = 9;
/**
 * Metres each kind keeps from any taxiway's centreline: the windsock, 6 m tall, from a wide-body's
 * wingtip; the light units, a metre tall, from its engines.
 */
export const WINDSOCK_CLEAR = 50;
export const PAPI_CLEAR = 40;
/** Metres either kind keeps from the middle of any road: half a service road's width and a margin. */
export const ROAD_CLEAR = 12;
/** How far along the runway a prop may be moved from where it usually stands, and in what steps, metres. */
const SHIFT = 150;
const STEP = 10;
/** The prevailing wind at SFO blows from about 290°: the socks stream towards 110°, map radians from east. */
export const DOWNWIND = ((90 - 110) * Math.PI) / 180;

export interface PropPlace {
  x: number;
  y: number;
  h: number;
  facing: number;
}

function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Where the windsocks and the approach-slope light units stand: placed from the mapped runways, taxiways and roads. */
export function airfieldPropPlaces(airfield: Airfield, roads: Roads): { socks: PropPlace[]; lights: PropPlace[] } {
  // Every stretch of taxiway and road as [ax, ay, bx, by].
  const taxiways: number[][] = [];
  for (const e of airfield.edges) {
    if (e.kind !== 'twy') continue;
    for (let i = 2; i < e.pts.length; i += 2) taxiways.push([e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1]]);
  }
  const roadways: number[][] = [];
  for (const e of roads.edges) for (let i = 3; i < e.pts.length; i += 3) roadways.push([e.pts[i - 3], e.pts[i - 2], e.pts[i], e.pts[i + 1]]);
  const clear = (x: number, y: number, margin: number): boolean =>
    taxiways.every(([ax, ay, bx, by]) => toSegment(x, y, ax, ay, bx, by) >= margin) && roadways.every(([ax, ay, bx, by]) => toSegment(x, y, ax, ay, bx, by) >= ROAD_CLEAR);
  /**
   * On the left (side 1) or else the right (-1), at the first of the distances out that has room:
   * the first of `usual`, usual ± STEP, usual ± 2 STEP... within SHIFT at which `fits`; or null.
   */
  const nearest = (usual: number, outs: readonly number[], fits: (along: number, side: number, out: number) => boolean): [number, number, number] | null => {
    for (const side of [1, -1]) {
      for (const out of outs) {
        for (let k = 0; k * STEP <= SHIFT; k += 1) {
          for (const along of k ? [usual + k * STEP, usual - k * STEP] : [usual]) if (fits(along, side, out)) return [along, side, out];
        }
      }
    }
    return null;
  };
  const socks: PropPlace[] = [];
  const lights: PropPlace[] = [];
  for (const runway of airfield.runways) {
    const [a, b] = runway.ends;
    for (const [end, other] of [[a, b], [b, a]] as const) {
      // Landing from this end towards the other: along the runway, and to the left of that.
      const length = Math.hypot(other.x - end.x, other.y - end.y);
      const ux = (other.x - end.x) / length;
      const uy = (other.y - end.y) / length;
      const lx = -uy;
      const ly = ux;
      const tx = end.x + ux * end.displaced;
      const ty = end.y + uy * end.displaced;
      const out = runway.width / 2;
      // `left` metres to the left of the centreline, `along` metres from the threshold.
      const at = (along: number, left: number): [number, number] => [tx + ux * along + lx * left, ty + uy * along + ly * left];
      const sock = nearest(WINDSOCK_IN, WINDSOCK_OUT, (along, side, off) => clear(...at(along, side * (out + off)), WINDSOCK_CLEAR));
      if (sock) {
        const [x, y] = at(sock[0], sock[1] * (out + sock[2]));
        socks.push({ x, y, h: 0, facing: DOWNWIND });
      }
      // The units in a row out from the runway's edge, the first nearest it.
      const units = (along: number, side: number): [number, number][] => Array.from({ length: 4 }, (_, k) => at(along, side * (out + PAPI_OUT + k * PAPI_SPACING)));
      const papi = nearest(PAPI_IN, [PAPI_OUT], (along, side) => units(along, side).every(([x, y]) => clear(x, y, PAPI_CLEAR)));
      // Facing back down the approach, to the aircraft coming in.
      if (papi) for (const [x, y] of units(papi[0], papi[1])) lights.push({ x, y, h: 0, facing: Math.atan2(-uy, -ux) });
    }
  }
  return { socks, lights };
}

export function buildAirfieldProps(airfield: Airfield, roads: Roads, models: Models): THREE.Group {
  const group = new THREE.Group();
  group.name = 'airfield-props';
  const windsock = models.get('windsock-d5df79');
  const papi = models.get('papi-unit-adc7c4');
  if (!windsock || !papi) return group;
  const { socks, lights } = airfieldPropPlaces(airfield, roads);
  const material = flatMaterial();
  group.add(propInstances(windsock, material, socks, 'windsocks'), propInstances(papi, material, lights, 'approach-slope-lights'));
  for (const mesh of group.children) (mesh as THREE.Mesh).castShadow = true;
  return group;
}
