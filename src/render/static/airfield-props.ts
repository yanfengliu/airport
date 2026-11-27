// The airfield's furniture, from Polyfork's airport kit, placed from the mapped runways, taxiways,
// roads, buildings and stands, each where such things usually stand, or moved as little as keeps it
// clear of what is there, as a real one is; where nowhere near is clear, it is left out:
// - beside each runway end, a windsock streaming downwind in the prevailing west-north-west wind and
//   the four light units of the approach-slope indicator on the left of the landing direction,
//   facing down the approach (on the right where the left has no room);
// - for each runway end the simulation lands on, the ILS: the localizer's antenna array across the
//   centreline beyond the far end, and the glide-path antenna beside the touchdown zone;
// - the airport's rotating beacon, in the open nearest the tower;
// - at every gate, a floodlight mast ahead of the parked aircraft, which carries the stand's
//   floodlight (where the terminal is too close for a mast, the floodlight is on its roof's edge
//   above the stand), and the docking guidance display on the terminal's face, looking down the stand.
// Placed once; without the models, nothing.

import * as THREE from 'three';
import { airframe } from '../../shared/airframe.ts';
import { outline } from '../../shared/footprint.ts';
import type { Layout, Stand } from '../../shared/layout.ts';
import { TaxiNet } from '../../sim/airfield/net.ts';
import { fuselageAt, newFuselage } from '../../sim/airfield/path.ts';
import { standPath } from '../../sim/airside/aircraft.ts';
import { SOUTHEAST_PLAN, WEST_PLAN } from '../../sim/airside/tower.ts';
import { AIRCRAFT, type AircraftType } from '../../sim/fleet.ts';
import { flatMaterial, propInstances, type Models } from '../models/library.ts';
import { BRIDGE_RETRACT, BRIDGE_SHORTEST, JET_BRIDGE, bridgeLines } from './bridges.ts';

/** Metres into the runway from the landing threshold, and out from its edge, of each kind: the windsock's the first of these with room. */
const WINDSOCK_IN = 300;
const WINDSOCK_OUT = [60, 45, 80, 100, 130];
const PAPI_IN = 300;
const PAPI_OUT = 15;
const PAPI_SPACING = 9;
/** The glide-path antenna: metres in from the threshold, and out from the centreline, the first of these with room. */
const GLIDE_IN = 300;
const GLIDE_OUT = [120, 150, 100, 180];
/** The localizer: metres beyond the far end of the runway, the first with room, and half its array's width. */
const LOCALIZER_BEYOND = [300, 260, 220, 180, 140, 100, 70];
const LOCALIZER_HALF = 12.4;
/**
 * Metres each kind keeps from any taxiway's centreline: the windsock, 6 m tall, and the glide-path
 * mast, 15 m, from a wide-body's wingtip; the light units, a metre tall, from its engines; the
 * localizer's array, 3 m, likewise.
 */
export const WINDSOCK_CLEAR = 50;
export const PAPI_CLEAR = 40;
export const GLIDE_CLEAR = 50;
export const LOCALIZER_CLEAR = 40;
/** Metres anything keeps from the middle of any road (half a service road's width and a margin), and of any railway or guideway. */
export const ROAD_CLEAR = 12;
export const RAIL_CLEAR = 12;
/** The beacon stands in the open: this far from any building, and from roads and railways. */
export const BEACON_CLEAR = { building: 60, way: 30, taxi: 60, stand: 90 };
/** How far along the runway a prop may be moved from where it usually stands, and in what steps, metres. */
const SHIFT = 150;
const STEP = 10;
/** The prevailing wind at SFO blows from about 290°: the socks stream towards 110°, map radians from east. */
export const DOWNWIND = ((90 - 110) * Math.PI) / 180;
/** The runway ends the simulation lands on, in either plan: those with an ILS. */
export const ILS_ENDS = [...new Set([...WEST_PLAN.arrivals, ...SOUTHEAST_PLAN.arrivals])];
/**
 * A gate's floodlight mast: metres ahead of where the nose wheel stops and to either side, tried in
 * turn; the height of its lamps; how far it keeps from buildings, from the bridges' walkways and
 * rotundas and the moving tunnel's path, and from roads and taxiways.
 */
const MAST_AHEAD = [26, 30, 22, 34, 38];
const MAST_SIDE = [0, 8, -8, 14, -14];
export const MAST_LAMP = 16;
export const MAST_CLEAR = { building: 2, walkway: 4, tunnel: 4, road: 6, taxiway: 25, aircraft: 3 };
/** The docking display: how far ahead the stand's line may meet the terminal, the height it hangs at, and its room from a bridge's walkway. */
const DISPLAY_REACH = [10, 90];
const DISPLAY_HEIGHT = 5.5;
const DISPLAY_WALKWAY = 2.5;

export interface PropPlace {
  x: number;
  y: number;
  h: number;
  facing: number;
}

export interface Furniture {
  socks: PropPlace[];
  lights: PropPlace[];
  localizers: (PropPlace & { end: string })[];
  glidePaths: (PropPlace & { end: string })[];
  beacons: PropPlace[];
  /** Per gate, by its stand: the floodlight mast and the docking display, where they found room. */
  masts: (PropPlace & { stand: string })[];
  displays: (PropPlace & { stand: string })[];
  /** Each gate's floodlight: on its mast's head, or on the terminal's roof above the stand. */
  floodlights: { x: number; y: number; h: number; stand: string }[];
}

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

/** Furthest any clearance asked of the index is, metres: it measures no further than this. */
const REACH = 120;
const CELL = 50;

/**
 * Line segments [ax, ay, bx, by], or rings, in a grid of CELL-metre cells, so that how near the
 * nearest comes to a point is found from the cells round it alone, up to REACH.
 */
class Near {
  private readonly cells = new Map<number, number[]>();
  private readonly items: readonly (readonly number[])[];
  private readonly measure: (item: readonly number[], x: number, y: number) => number;

  constructor(items: readonly (readonly number[])[], measure: (item: readonly number[], x: number, y: number) => number) {
    this.items = items;
    this.measure = measure;
    items.forEach((item, k) => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < item.length; i += 2) {
        x0 = Math.min(x0, item[i]);
        x1 = Math.max(x1, item[i]);
        y0 = Math.min(y0, item[i + 1]);
        y1 = Math.max(y1, item[i + 1]);
      }
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx += 1) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy += 1) {
          const key = cx * 100003 + cy;
          const list = this.cells.get(key);
          if (list) list.push(k);
          else this.cells.set(key, [k]);
        }
      }
    });
  }

  /** How near the nearest item comes to (x, y), metres, or REACH if none comes nearer. */
  from(x: number, y: number): number {
    let least = REACH;
    const seen = new Set<number>();
    const r = Math.ceil(REACH / CELL);
    const [cx, cy] = [Math.floor(x / CELL), Math.floor(y / CELL)];
    for (let i = cx - r; i <= cx + r; i += 1) {
      for (let j = cy - r; j <= cy + r; j += 1) {
        for (const k of this.cells.get(i * 100003 + j) ?? []) {
          if (seen.has(k)) continue;
          seen.add(k);
          least = Math.min(least, this.measure(this.items[k], x, y));
        }
      }
    }
    return least;
  }
}

const segments = (list: readonly number[][]): Near => new Near(list, ([ax, ay, bx, by], x, y) => toSegment(x, y, ax, ay, bx, by));

/** Where along a ray from (x, y) heading (c, s) it first crosses a ring's edge, metres, or Infinity. */
function rayHit(ring: readonly number[], x: number, y: number, c: number, s: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ex = ring[i] - ring[j];
    const ey = ring[i + 1] - ring[j + 1];
    const den = c * ey - s * ex;
    if (Math.abs(den) < 1e-9) continue;
    const wx = ring[j] - x;
    const wy = ring[j + 1] - y;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * s - wy * c) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/** Where every piece of the airfield's furniture stands. */
export function airfieldFurniture(layout: Pick<Layout, 'airfield' | 'roads' | 'rail' | 'land' | 'terminals' | 'buildings'>): Furniture {
  const { airfield, roads, land } = layout;
  // Every stretch of taxiway and road as [ax, ay, bx, by].
  const taxiways: number[][] = [];
  for (const e of airfield.edges) {
    if (e.kind !== 'twy') continue;
    for (let i = 2; i < e.pts.length; i += 2) taxiways.push([e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1]]);
  }
  const roadways: number[][] = [];
  for (const e of roads.edges) for (let i = 3; i < e.pts.length; i += 3) roadways.push([e.pts[i - 3], e.pts[i - 2], e.pts[i], e.pts[i + 1]]);
  const railways: number[][] = [];
  for (const l of layout.rail.lines) for (let i = 3; i < l.pts.length; i += 3) railways.push([l.pts[i - 3], l.pts[i - 2], l.pts[i], l.pts[i + 1]]);
  // How near each comes, measured up to REACH, which every clearance asked is within.
  const nearTaxiways = segments(taxiways);
  const nearRoads = segments(roadways);
  const nearRails = segments(railways);
  const fromTaxiways = (x: number, y: number): number => nearTaxiways.from(x, y);
  const fromRoads = (x: number, y: number): number => nearRoads.from(x, y);
  const fromRails = (x: number, y: number): number => nearRails.from(x, y);
  const clear = (x: number, y: number, margin: number): boolean => fromTaxiways(x, y) >= margin && fromRoads(x, y) >= ROAD_CLEAR && fromRails(x, y) >= RAIL_CLEAR;
  const onAirport = (x: number, y: number): boolean => land.airport.some((p) => inside(p.outer, x, y));
  const offRunways = (x: number, y: number, margin: number): boolean =>
    airfield.runways.every((r) => toSegment(x, y, r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y) >= r.width / 2 + margin);
  /**
   * On side `sides[0]` or else `sides[1]` (1 left, -1 right), at the first of the distances out that
   * has room: the first of `usual`, usual ± STEP, usual ± 2 STEP... within SHIFT at which `fits`; or null.
   */
  const nearest = (usual: number, outs: readonly number[], fits: (along: number, side: number, out: number) => boolean, sides = [1, -1]): [number, number, number] | null => {
    for (const side of sides) {
      for (const out of outs) {
        for (let k = 0; k * STEP <= SHIFT; k += 1) {
          for (const along of k ? [usual + k * STEP, usual - k * STEP] : [usual]) if (fits(along, side, out)) return [along, side, out];
        }
      }
    }
    return null;
  };
  const furniture: Furniture = { socks: [], lights: [], localizers: [], glidePaths: [], beacons: [], masts: [], displays: [], floodlights: [] };
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
      const approach = Math.atan2(-uy, -ux);
      // `left` metres to the left of the centreline, `along` metres from the threshold.
      const at = (along: number, left: number): [number, number] => [tx + ux * along + lx * left, ty + uy * along + ly * left];
      const sock = nearest(WINDSOCK_IN, WINDSOCK_OUT, (along, side, off) => clear(...at(along, side * (out + off)), WINDSOCK_CLEAR));
      if (sock) {
        const [x, y] = at(sock[0], sock[1] * (out + sock[2]));
        furniture.socks.push({ x, y, h: 0, facing: DOWNWIND });
      }
      // The units in a row out from the runway's edge, the first nearest it.
      const units = (along: number, side: number): [number, number][] => Array.from({ length: 4 }, (_, k) => at(along, side * (out + PAPI_OUT + k * PAPI_SPACING)));
      const papi = nearest(PAPI_IN, [PAPI_OUT], (along, side) => units(along, side).every(([x, y]) => clear(x, y, PAPI_CLEAR)));
      // Facing back down the approach, to the aircraft coming in.
      if (papi) for (const [x, y] of units(papi[0], papi[1])) furniture.lights.push({ x, y, h: 0, facing: approach });
      if (!ILS_ENDS.includes(end.name)) continue;
      // The glide path beside the touchdown zone, on the side away from the light units, clear of
      // them, of the windsock and of every other runway's strip.
      const near = [...furniture.socks, ...furniture.lights];
      const glide = nearest(
        GLIDE_IN,
        GLIDE_OUT,
        (along, side, off) => {
          const [x, y] = at(along, side * off);
          return clear(x, y, GLIDE_CLEAR) && onAirport(x, y) && offRunways(x, y, 75) && near.every((p) => Math.hypot(p.x - x, p.y - y) >= 30);
        },
        papi ? [-papi[1], papi[1]] : [-1, 1],
      );
      if (glide) {
        const [x, y] = at(glide[0], glide[1] * glide[2]);
        furniture.glidePaths.push({ x, y, h: 0, facing: approach, end: end.name });
      }
      // The localizer across the centreline beyond the far end, its array on airport ground and clear.
      for (const beyond of LOCALIZER_BEYOND) {
        const along = length - end.displaced + beyond;
        const tips = [at(along, LOCALIZER_HALF), at(along, -LOCALIZER_HALF), at(along, 0)];
        if (!tips.every(([x, y]) => onAirport(x, y) && clear(x, y, LOCALIZER_CLEAR))) continue;
        const [x, y] = tips[2];
        furniture.localizers.push({ x, y, h: 0, facing: approach, end: end.name });
        break;
      }
    }
  }

  // The bridges' fixed walkways and rotundas, and the buildings, which the gates' furniture keeps from.
  const lines = bridgeLines(layout);
  const walkways = lines.flatMap((l) => l.fixed.map((f) => [f.x0, f.y0, f.x1, f.y1]));
  const rotundas = lines.map((l) => [l.end.x0, l.end.y0]);
  const nearBuildings = new Near([...layout.terminals.buildings.map((t) => t.poly.outer), ...layout.buildings.buildings.map((b) => b.poly.outer)], (ring, x, y) => ringReach(ring, x, y));
  const fromBuildings = (x: number, y: number): number => nearBuildings.from(x, y);

  // The beacon: the nearest open ground to the tower, on the airport, clear of everything, the lines
  // aircraft follow onto their stands and the stands themselves included.
  const [towerX, towerY] = airfield.tower;
  const taxiLines: number[][] = [];
  for (const e of airfield.edges) for (let i = 2; i < e.pts.length; i += 2) taxiLines.push([e.pts[i - 2], e.pts[i - 1], e.pts[i], e.pts[i + 1]]);
  const nearTaxiLines = segments(taxiLines);
  // Cheapest first.
  const open = (x: number, y: number): boolean =>
    airfield.stands.every((st) => Math.hypot(st.x - x, st.y - y) >= BEACON_CLEAR.stand) &&
    offRunways(x, y, 100) &&
    onAirport(x, y) &&
    nearTaxiLines.from(x, y) >= BEACON_CLEAR.taxi &&
    fromRoads(x, y) >= BEACON_CLEAR.way &&
    fromRails(x, y) >= BEACON_CLEAR.way &&
    airfield.aprons.every((p) => ringReach(p.poly.outer, x, y) >= 10) &&
    fromBuildings(x, y) >= BEACON_CLEAR.building;
  search: for (let r = 100; r <= 2500; r += 50) {
    const around = Math.max(12, Math.round((2 * Math.PI * r) / 80));
    for (let k = 0; k < around; k += 1) {
      const x = towerX + r * Math.cos((k / around) * 2 * Math.PI);
      const y = towerY + r * Math.sin((k / around) * 2 * Math.PI);
      if (!open(x, y)) continue;
      furniture.beacons.push({ x, y, h: 0, facing: 0 });
      break search;
    }
  }

  // At each gate: the mast ahead of the aircraft and the display on the terminal's face.
  const types = Object.values(AIRCRAFT);
  const fits = (stand: Stand): AircraftType[] => types.filter((t) => t.span <= stand.span + 0.5);
  // Where an aircraft of a type parks at a stand, as the simulation parks it: at the end of its
  // stand's line, which some stands curve in along.
  const net = new TaxiNet(airfield);
  const poses = new Map<string, { x: number; y: number; heading: number } | null>();
  const poseAt = (stand: Stand, type: AircraftType): { x: number; y: number; heading: number } | null => {
    const key = `${stand.id}:${type.id}`;
    if (!poses.has(key)) {
      const path = standPath(net, stand.id, type.length);
      const at = path ? fuselageAt(path, path.total, newFuselage()) : null;
      poses.set(key, at ? { x: at.x, y: at.y, heading: at.heading } : null);
    }
    return poses.get(key)!;
  };
  // The paths every bridge's moving tunnel and cab take: from its rotunda to a cab's length off the
  // fuselage at the front door of each type its stand takes (src/render/dynamic/bridge-layer.ts),
  // and pulled back along the mapped line, its cab reaching a cab's length beyond the tunnel's end.
  const tunnels: number[][] = [];
  const reach = JET_BRIDGE.door - JET_BRIDGE.drum;
  for (const line of lines) {
    const stand = airfield.stands.find((o) => o.id === line.stand)!;
    const { x0, y0, x1, y1, length } = line.end;
    const back = Math.min(length, Math.max(BRIDGE_SHORTEST, length - BRIDGE_RETRACT)) + reach;
    tunnels.push([x0, y0, x0 + ((x1 - x0) / length) * Math.max(length, back), y0 + ((y1 - y0) / length) * Math.max(length, back)]);
    for (const type of fits(stand)) {
      const at = poseAt(stand, type);
      if (!at) continue;
      const f = airframe(type);
      // Its front door on the bridge's side.
      const ac = Math.cos(at.heading);
      const as = Math.sin(at.heading);
      const side = (x0 - at.x) * -as + (y0 - at.y) * ac >= 0 ? 1 : -1;
      const out = f.ry + 0.4 + reach;
      tunnels.push([x0, y0, at.x + ac * f.doors.front.x - as * side * out, at.y + as * f.doors.front.x + ac * side * out]);
    }
  }
  for (const stand of airfield.stands) {
    if (!stand.contact) continue;
    const c = Math.cos(stand.heading);
    const s = Math.sin(stand.heading);
    // Every aircraft this stand and those near it can take, as parked there.
    const parked = airfield.stands
      .filter((o) => Math.hypot(o.x - stand.x, o.y - stand.y) < 150)
      .flatMap((o) =>
        fits(o).flatMap((t) => {
          const at = poseAt(o, t);
          return at ? outline(t, at.x, at.y, at.heading) : [];
        }),
      );
    const mastFits = (x: number, y: number): boolean =>
      fromBuildings(x, y) >= MAST_CLEAR.building &&
      walkways.every(([ax, ay, bx, by]) => toSegment(x, y, ax, ay, bx, by) >= MAST_CLEAR.walkway + JET_BRIDGE.linkHalf) &&
      rotundas.every(([rx, ry]) => Math.hypot(x - rx, y - ry) >= MAST_CLEAR.walkway + 2) &&
      tunnels.every(([ax, ay, bx, by]) => toSegment(x, y, ax, ay, bx, by) >= MAST_CLEAR.tunnel + 2) &&
      fromRoads(x, y) >= MAST_CLEAR.road &&
      fromRails(x, y) >= RAIL_CLEAR &&
      fromTaxiways(x, y) >= MAST_CLEAR.taxiway &&
      parked.every((poly) => ringReach(poly, x, y) >= MAST_CLEAR.aircraft);
    mast: for (const ahead of MAST_AHEAD) {
      for (const across of MAST_SIDE) {
        const x = stand.x + c * ahead - s * across;
        const y = stand.y + s * ahead + c * across;
        if (!mastFits(x, y)) continue;
        // Its lamps look back down the stand.
        furniture.masts.push({ x, y, h: 0, facing: stand.heading + Math.PI, stand: stand.id });
        furniture.floodlights.push({ x, y, h: MAST_LAMP, stand: stand.id });
        break mast;
      }
    }
    // Where the stand's line meets the terminal's face, and that building's height.
    let hit = Infinity;
    let roof = 0;
    for (const t of layout.terminals.buildings) {
      const at = rayHit(t.poly.outer, stand.x, stand.y, c, s);
      if (at < hit) [hit, roof] = [at, t.height];
    }
    // No room for a mast: the floodlight on the roof's edge there.
    if (!furniture.masts.some((m) => m.stand === stand.id) && hit <= DISPLAY_REACH[1]) {
      furniture.floodlights.push({ x: stand.x + c * (hit + 0.5), y: stand.y + s * (hit + 0.5), h: roof + 1, stand: stand.id });
    }
    // The display on the face, a little in front of it, clear of a bridge's walkway leaving the face
    // there: on the stand's line, or beside it, where a line parallel to it meets the face.
    for (const across of [0, 3, -3, 6, -6]) {
      const ox = stand.x - s * across;
      const oy = stand.y + c * across;
      const face = layout.terminals.buildings.reduce((m, t) => Math.min(m, rayHit(t.poly.outer, ox, oy, c, s)), Infinity);
      if (face < DISPLAY_REACH[0] || face > DISPLAY_REACH[1]) continue;
      const x = ox + c * (face - 0.6);
      const y = oy + s * (face - 0.6);
      if (!walkways.every(([ax, ay, bx, by]) => toSegment(x, y, ax, ay, bx, by) >= DISPLAY_WALKWAY + JET_BRIDGE.linkHalf)) continue;
      furniture.displays.push({ x, y, h: DISPLAY_HEIGHT, facing: stand.heading + Math.PI, stand: stand.id });
      break;
    }
  }
  return furniture;
}

/** Polyfork's models of each piece. */
const KIT = {
  socks: 'windsock-d5df79',
  lights: 'papi-unit-adc7c4',
  localizers: 'ils-localizer-antenna-array-f094b7',
  glidePaths: 'ils-glide-path-antenna-15d814',
  beacons: 'rotating-airport-beacon-e1ea5a',
  masts: 'apron-floodlight-mast-e0d04a',
  displays: 'stand-docking-guidance-display-2a0b05',
} as const satisfies Record<Exclude<keyof Furniture, 'floodlights'>, string>;

export function buildAirfieldProps(furniture: Furniture, models: Models): THREE.Group {
  const group = new THREE.Group();
  group.name = 'airfield-props';
  const material = flatMaterial();
  for (const [kind, id] of Object.entries(KIT) as [keyof typeof KIT, string][]) {
    const model = models.get(id);
    if (!model || !furniture[kind].length) continue;
    const mesh = propInstances(model, material, furniture[kind], `airfield-${kind}`);
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}
