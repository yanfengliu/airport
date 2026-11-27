// Inside the terminals, for the cut-away view: each level's floor, tiled in the halls and
// carpeted where people sit at the gates; the glass the buildings are walled with; the walls and
// glass fronts of the shops, cafés, lounges and toilets; and everything the simulation lays out
// inside (see src/sim/terminal/fittings.ts), drawn with the low-poly models of the library:
// check-in desks, kiosks, security lanes, passport booths, gate desks and seats, carousels,
// shelves, counters, tables, plants and stanchions. Bags ride the carousels and the check-in
// belts, and trays the x-ray belts. One group per level; the view shows one at a time.

import * as THREE from 'three';
import type { AreaKind, Layout, PolygonData } from '../../shared/layout.ts';
import { CAROUSEL_STRAIGHT, CAROUSEL_WIDTH, DESK_FROM_PASSENGER, EDGE, LANE, SIZE, type Carousel, type Fitting, type FittingKind } from '../../sim/terminal/fittings.ts';
import { FLOOR, FLOOR_HEIGHT } from '../../sim/terminal/plan.ts';
import type { Terminals } from '../../sim/terminal/terminals.ts';
import { MeshBuilder, box, fillPolygon, rgb, shade, type RGB } from '../builder.ts';
import { flatMaterial, placement, propInstances, type Model, type Models } from '../models/library.ts';
import { ORDER, solidMesh } from './common.ts';

const SLAB: RGB = rgb(0xdcd8cf);
const LOWER_SLAB: RGB = rgb(0xd3cec4);
const CARPET: RGB = rgb(0x4f5e74);
/** Floors of the rooms, by what they are for: tile, carpet or wood, in the colours they come in. */
const ROOM_FLOOR: Partial<Record<AreaKind, { colour: RGB; carpet?: boolean }>> = {
  checkin: { colour: rgb(0xe6e1d6) },
  security: { colour: rgb(0xcdcfd0) },
  claim: { colour: rgb(0xd9d4ca) },
  customs: { colour: rgb(0xd2d5da) },
  gate: { colour: rgb(0x56657a), carpet: true },
  food: { colour: rgb(0xcdbb9d) },
  shop: { colour: rgb(0xd9c6a3) },
  lounge: { colour: rgb(0x5e5168), carpet: true },
  toilets: { colour: rgb(0xe3e7ea) },
};
/** Rooms of these kinds are on the arrivals level; everything else is upstairs. */
const DOWNSTAIRS = new Set<AreaKind>(['claim']);
const WALL: Partial<Record<AreaKind, RGB>> = {
  shop: rgb(0xe9e5dd),
  food: rgb(0xe4d8c6),
  toilets: rgb(0xf1f1ee),
  lounge: rgb(0x8c7f94),
};
const CUT: RGB = rgb(0x3b3f45);
const MULLION: RGB = rgb(0x5d646c);
/** Fascia colours over the shop fronts. */
const FASCIA = [0x3a4d6b, 0xb94c34, 0x497aa2, 0x658049, 0x836047, 0x282f3f, 0xae6051, 0x3e6495].map(rgb);
/** The airlines' colours on the walls behind check-in, in the order of BRANDS. */
const BRAND = [0x1b3c78, 0x8d96a0, 0x1f4f9c, 0x304cb2, 0x0a3a5a, 0x9b1631].map(rgb);
const NO_BRAND: RGB = rgb(0x6f7780);
/** Height of the glass round the buildings, and of the walls of rooms inside, metres. */
const GLASS_HEIGHT = 4.2;
const ROOM_WALL = 3.0;

/** The model each kind of fitting is drawn with; null for those drawn here from boxes. */
export const MODEL_OF: Record<FittingKind, string | null> = {
  desk: 'check-in-desk-run-b96c12',
  backwall: null,
  kiosk: 'self-check-in-kiosk-3fe1c1',
  board: 'departures-board-7b85c8',
  xray: 'x-ray-baggage-conveyor-b3d1cc',
  scanner: 'security-body-scanner-ef6fcd',
  arch: 'walk-through-security-arch-5c2a43',
  bins: null,
  booth: 'passport-control-booth-7724c6',
  podium: 'gate-boarding-desk-8e0555',
  reader: null,
  shelf: 'back-bar-shelf-unit-11ab89',
  gondola: 'toy-shelf-3b4390',
  till: 'bar-counter-run-ab3b08',
  newsstand: 'newsstand-6dfd65',
  counter: 'cafe-counter-d8b226',
  kitchen: 'back-bar-shelf-unit-11ab89',
  table: 'cafe-table-set-1868d1',
  lowtable: 'lounge-drum-table-13d029',
  plant: 'floor-houseplant-8fad17',
  bin: 'street-bin-770173',
  trolleys: 'passenger-luggage-trolley-2e11d7',
};
const SEAT_ROW = 'gate-seating-row-cc0ff3';
const TUB_CHAIR = 'velvet-tub-chair-b0b5f8';
const CAROUSEL = 'baggage-reclaim-carousel-7ceef0';
const STANCHIONS = 'queue-barrier-stanchion-run-1836c8';
const SUITCASE = 'spinner-suitcase-1a55f1';
/** Further than this, metres of camera distance, the furniture is too small to see and is not drawn. */
const DETAIL_DISTANCE = 900;
/** Size of the tiles the furniture is drawn in, metres. */
const TILE = 400;
/** Bags drawn on one carousel at most, and on all the check-in belts. */
const BAGS_ON_CAROUSEL = 48;
const BAGS_AT_CHECKIN = 600;

export interface Interiors {
  departures: THREE.Group;
  arrivals: THREE.Group;
  /** Move the bags and trays; `time` is the simulation's clock, seconds; furniture shows when the camera is near enough. */
  update(terminals: Terminals, time: number, cameraDistance?: number): void;
}

/** A tileable grey texture centred on white: tiles with grout, or carpet's fleck. */
function floorTexture(carpet: boolean): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  let seed = carpet ? 91 : 37;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < size * size; i += 1) {
    const v = carpet ? 0.9 + (random() - 0.5) * 0.16 : 0.96 + (random() - 0.5) * 0.05;
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    image.data[i * 4] = byte;
    image.data[i * 4 + 1] = byte;
    image.data[i * 4 + 2] = byte;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  if (!carpet) {
    // Four tiles a side, with grout between.
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let k = 0; k < 4; k += 1) {
      ctx.fillRect(k * 64, 0, 1, size);
      ctx.fillRect(0, k * 64, size, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** A wall along an edge: a box from h0 to h1, `thick` metres, from (x0, y0) to (x1, y1). */
function wallAlong(b: MeshBuilder, x0: number, y0: number, x1: number, y1: number, h0: number, h1: number, thick: number, side: RGB, top: RGB): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 0.05) return;
  box(b, (x0 + x1) / 2, (y0 + y1) / 2, h0, h1, len / 2, thick / 2, Math.atan2(y1 - y0, x1 - x0), side, top);
}

/** A pane of glass along an edge, both faces. */
function pane(b: MeshBuilder, x0: number, y0: number, x1: number, y1: number, h0: number, h1: number, c: RGB): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  for (const s of [1, -1]) {
    const a = b.vertex(x0, y0, h0, nx * s, ny * s, 0, c);
    const v = b.vertex(x1, y1, h0, nx * s, ny * s, 0, c);
    const w = b.vertex(x1, y1, h1, nx * s, ny * s, 0, c);
    const z = b.vertex(x0, y0, h1, nx * s, ny * s, 0, c);
    if (s > 0) b.quad(a, v, w, z);
    else b.quad(v, a, z, w);
  }
}

/**
 * Glass from h0 to h1 along each edge of a ring that is an outside wall, mullions every `bay`
 * metres, a base and a cut line on top. An edge with floor on both sides is where two of the
 * map's building parts meet inside a hall: no wall stands there.
 */
function glassRing(glass: MeshBuilder, frame: MeshBuilder, ring: readonly number[], h: number, height: number, bay: number, floorAt: (x: number, y: number) => boolean): void {
  const n = ring.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const [x0, y0, x1, y1] = [ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.05) continue;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const nx = (y1 - y0) / len;
    const ny = -(x1 - x0) / len;
    if (floorAt(mx + nx * 2.6, my + ny * 2.6) && floorAt(mx - nx * 2.6, my - ny * 2.6)) continue;
    pane(glass, x0, y0, x1, y1, h + 0.25, h + height, rgb(0xffffff));
    wallAlong(frame, x0, y0, x1, y1, h - 0.05, h + 0.25, 0.22, MULLION, MULLION);
    wallAlong(frame, x0, y0, x1, y1, h + height, h + height + 0.28, 0.3, CUT, CUT);
    const bays = Math.max(1, Math.round(len / bay));
    for (let k = 0; k <= bays; k += 1) {
      const t = k / bays;
      box(frame, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, h, h + height, 0.05, 0.07, Math.atan2(y1 - y0, x1 - x0), MULLION, MULLION);
    }
  }
}

type Placed = { x: number; y: number; h: number; facing: number; sx?: number; sy?: number; sz?: number; tilt?: number };

export function buildInteriors(layout: Layout, terminals: Terminals, models: Models): Interiors {
  const fittings = terminals.fittings;
  const upstairs = FLOOR_HEIGHT[FLOOR.landside];
  const downstairs = FLOOR_HEIGHT[FLOOR.arrivals];
  const heightOf = (floor: number): number => FLOOR_HEIGHT[floor] ?? upstairs;
  const level = (floor: number): 'up' | 'down' => (floor === FLOOR.arrivals ? 'down' : 'up');
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const tiles = new THREE.MeshLambertMaterial({ vertexColors: true, map: floorTexture(false) });
  const carpetMap = floorTexture(true);
  const overlay = (map: THREE.Texture): THREE.MeshLambertMaterial =>
    new THREE.MeshLambertMaterial({ vertexColors: true, map, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const tileOverlay = overlay(tiles.map!);
  const carpetOverlay = overlay(carpetMap);
  const glassMaterial = new THREE.MeshLambertMaterial({ color: 0xbcd6e4, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
  const flat = flatMaterial();
  const model = (id: string): Model | null => models.get(id) ?? null;

  const groups = { up: new THREE.Group(), down: new THREE.Group() };
  groups.up.name = 'interior-departures';
  groups.down.name = 'interior-arrivals';

  // ---- floors -----------------------------------------------------------------------------
  const UV = 1 / 4.8;
  for (const [lv, h, slab] of [['up', upstairs, SLAB], ['down', downstairs, LOWER_SLAB]] as const) {
    const floor = new MeshBuilder();
    for (const b of layout.terminals.buildings) fillPolygon(floor, b.poly, h - 0.05, slab, UV);
    const mesh = solidMesh(floor, tiles, `interior-${lv}-floor`, false);
    // Drawn after the paint on the ground: the paint is pulled towards the camera so the layers on
    // the ground do not fight, and from far off that is enough to cover a floor half a metre up.
    mesh.renderOrder = ORDER.paintText + 1;
    groups[lv].add(mesh);
    // The rooms, mapped on several levels of the building and all shown on this one floor: one
    // mesh per mapped level and kind of floor, drawn over the floor in order of level, so that
    // where two overlap in plan the upper one shows, every frame, instead of the two flickering.
    const byLevel = new Map<string, { builder: MeshBuilder; rank: number; carpet: boolean }>();
    for (const a of layout.terminals.areas) {
      const look = ROOM_FLOOR[a.kind];
      if (!look || DOWNSTAIRS.has(a.kind) !== (lv === 'down')) continue;
      const key = `${a.level ?? 0}:${look.carpet ? 1 : 0}`;
      let entry = byLevel.get(key);
      if (!entry) byLevel.set(key, (entry = { builder: new MeshBuilder(), rank: a.level ?? 0, carpet: Boolean(look.carpet) }));
      fillPolygon(entry.builder, a.poly as PolygonData, h + 0.02, look.colour, UV);
    }
    const ranks = [...new Set([...byLevel.values()].map((e) => e.rank))].sort((p, q) => p - q);
    for (const [key, e] of byLevel) {
      const m = new THREE.Mesh(e.builder.build(), e.carpet ? carpetOverlay : tileOverlay);
      m.name = `interior-${lv}-rooms-${key}`;
      m.renderOrder = ORDER.paintText + 2 + ranks.indexOf(e.rank);
      m.matrixAutoUpdate = false;
      groups[lv].add(m);
    }
  }
  // Carpet where people sit at the gates: under each row and a little round it.
  {
    const rug = new MeshBuilder();
    const seats = fittings.seats;
    for (const row of fittings.groups) {
      if (row.kind !== 'gate') continue;
      const a = row.first;
      const z = row.first + row.count - 1;
      const [x0, y0, x1, y1] = [seats[a * 3], seats[a * 3 + 1], seats[z * 3], seats[z * 3 + 1]];
      const facing = seats[a * 3 + 2];
      const h = heightOf(row.floor);
      box(rug, (x0 + x1) / 2 + Math.cos(facing) * 0.2, (y0 + y1) / 2 + Math.sin(facing) * 0.2, h + 0.03, h + 0.035, Math.hypot(x1 - x0, y1 - y0) / 2 + 1.2, 1.0, Math.atan2(y1 - y0, x1 - x0), CARPET, CARPET);
    }
    const m = new THREE.Mesh(rug.build(), carpetOverlay);
    m.name = 'interior-gate-carpet';
    m.renderOrder = ORDER.paintText + 12;
    m.matrixAutoUpdate = false;
    groups.up.add(m);
  }

  // ---- walls ------------------------------------------------------------------------------
  for (const [lv, h] of [['up', upstairs], ['down', downstairs]] as const) {
    const glass = new MeshBuilder();
    const frame = new MeshBuilder();
    const grids = lv === 'up' ? [terminals.plan.grids[FLOOR.landside], terminals.plan.grids[FLOOR.airside]] : [terminals.plan.grids[FLOOR.arrivals]];
    const floorAt = (x: number, y: number): boolean => grids.some((g) => g.cellAt(x, y) >= 0);
    for (const b of layout.terminals.buildings) for (const ring of [b.poly.outer, ...(b.poly.holes ?? [])]) glassRing(glass, frame, ring, h, GLASS_HEIGHT, 3.0, floorAt);
    if (lv === 'up') {
      for (const room of fittings.rooms) {
        const area = layout.terminals.areas[room.room];
        const r = area.poly.outer;
        const n = r.length / 2;
        const wall = WALL[room.kind] ?? WALL.shop!;
        const fascia = FASCIA[(room.room * 5) % FASCIA.length];
        for (let i = 0; i < n; i += 1) {
          const j = (i + 1) % n;
          const [x0, y0, x1, y1] = [r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1]];
          const edge = room.edges[i];
          if (edge === EDGE.solid) {
            wallAlong(frame, x0, y0, x1, y1, h, h + ROOM_WALL, 0.16, wall, CUT);
            continue;
          }
          // A shop front: a fascia band over glass, or over the way in.
          wallAlong(frame, x0, y0, x1, y1, h + ROOM_WALL - 0.45, h + ROOM_WALL, 0.2, room.kind === 'toilets' ? wall : fascia, CUT);
          if (edge === EDGE.glass) {
            pane(glass, x0, y0, x1, y1, h + 0.05, h + ROOM_WALL - 0.45, rgb(0xffffff));
            const len = Math.hypot(x1 - x0, y1 - y0);
            const bays = Math.max(1, Math.round(len / 1.6));
            for (let k = 0; k <= bays; k += 1) box(frame, x0 + ((x1 - x0) * k) / bays, y0 + ((y1 - y0) * k) / bays, h, h + ROOM_WALL - 0.45, 0.04, 0.05, Math.atan2(y1 - y0, x1 - x0), MULLION, MULLION);
          }
        }
      }
    }
    groups[lv].add(solidMesh(frame, material, `interior-${lv}-walls`, false));
    const glassMesh = new THREE.Mesh(glass.build(), glassMaterial);
    glassMesh.name = `interior-${lv}-glass`;
    glassMesh.renderOrder = 50;
    glassMesh.matrixAutoUpdate = false;
    groups[lv].add(glassMesh);
  }

  // ---- fittings, by model -----------------------------------------------------------------
  const placed = { up: new Map<string, Placed[]>(), down: new Map<string, Placed[]>() };
  const at = (lv: 'up' | 'down', id: string, p: Placed): void => {
    const list = placed[lv].get(id) ?? [];
    list.push(p);
    placed[lv].set(id, list);
  };
  const own = { up: new MeshBuilder(), down: new MeshBuilder() };
  const fitting = (f: Fitting): void => {
    const lv = level(f.floor);
    const h = heightOf(f.floor);
    const facing = f.heading - Math.PI / 2;
    const id = MODEL_OF[f.kind];
    const m = id ? model(id) : null;
    if (f.kind === 'gondola' && m) {
      // Two shelf units back to back.
      for (const s of [1, -1]) {
        const off = (SIZE.gondola[1] / 4) * s;
        at(lv, m.info.id, { x: f.x + Math.cos(facing) * off, y: f.y + Math.sin(facing) * off, h, facing: s > 0 ? facing : facing + Math.PI });
      }
      return;
    }
    if (f.kind === 'trolleys' && m) {
      // A row of trolleys nested one into the next.
      for (let k = 0; k < 5; k += 1) {
        const off = (k - 2) * 0.5;
        at(lv, m.info.id, { x: f.x + Math.cos(facing) * off, y: f.y + Math.sin(facing) * off, h, facing });
      }
      return;
    }
    if (m) {
      const [sx, sy, sz] = m.info.size;
      at(lv, m.info.id, { x: f.x, y: f.y, h, facing, sx: f.length / sx, sy: f.height / sy, sz: f.width / sz });
      return;
    }
    const b = own[lv];
    if (f.kind === 'backwall') {
      const c = f.tint >= 0 ? BRAND[f.tint] : NO_BRAND;
      box(b, f.x, f.y, h, h + f.height - 0.4, f.length / 2, f.width / 2, f.heading, rgb(0xe4e2dd), rgb(0xd0cdc6));
      box(b, f.x, f.y, h + f.height - 0.4, h + f.height, f.length / 2, f.width / 2 + 0.02, f.heading, c, shade(c, 0.8));
    } else if (f.kind === 'reader') {
      box(b, f.x, f.y, h, h + f.height, 0.12, 0.12, f.heading, rgb(0x3a3f45), rgb(0x22262b));
    } else if (f.kind === 'bins') {
      // A stack of grey trays.
      box(b, f.x, f.y, h, h + f.height, f.length / 2, f.width / 2, f.heading, rgb(0x8f959c), rgb(0x6f757c));
    }
  };
  for (const f of fittings.items) fitting(f);

  // Seats at the gates: rows of two four-seat modules; armchairs in the lounges.
  const seats = fittings.seats;
  for (const g of fittings.groups) {
    const lv = level(g.floor);
    const h = heightOf(g.floor);
    if (g.kind === 'gate') {
      for (let k = 0; k + 3 < g.count; k += 4) {
        const a = g.first + k;
        const z = a + 3;
        at(lv, SEAT_ROW, { x: (seats[a * 3] + seats[z * 3]) / 2, y: (seats[a * 3 + 1] + seats[z * 3 + 1]) / 2, h, facing: seats[a * 3 + 2] });
      }
    } else if (g.kind === 'lounge') {
      for (let k = 0; k < g.count; k += 1) {
        const s = g.first + k;
        at(lv, TUB_CHAIR, { x: seats[s * 3], y: seats[s * 3 + 1], h, facing: seats[s * 3 + 2] });
      }
    }
  }

  // Carousels: four modules of belt along each side, facing out, and an island and half circles of belt made here to match.
  const carouselModel = model(CAROUSEL);
  const plate = carouselModel ? extreme(carouselModel, 1) : rgb(0xb9bcc0);
  const base = carouselModel ? extreme(carouselModel, -1) : rgb(0x3a3f45);
  for (const c of fittings.carousels) {
    const lv = level(c.floor);
    const h = heightOf(c.floor);
    const ux = Math.cos(c.heading);
    const uy = Math.sin(c.heading);
    const off = CAROUSEL_WIDTH / 2 - 0.6;
    for (let k = 0; k < 4; k += 1) {
      const along = -CAROUSEL_STRAIGHT / 2 + 2 + k * 4;
      for (const side of [1, -1]) {
        at(lv, CAROUSEL, { x: c.x + ux * along - uy * off * side, y: c.y + uy * along + ux * off * side, h, facing: c.heading + (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
      }
    }
    carouselEnds(own[lv], c, h, plate, base);
  }

  // Stanchions along every rope, stretched a little to fit each run.
  const stanchion = model(STANCHIONS);
  if (stanchion) {
    const length = stanchion.info.size[0];
    for (const rope of fittings.ropes) {
      const lv = level(rope.floor);
      const h = heightOf(rope.floor);
      for (let i = 2; i < rope.pts.length; i += 2) {
        const [x0, y0, x1, y1] = [rope.pts[i - 2], rope.pts[i - 1], rope.pts[i], rope.pts[i + 1]];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.5) continue;
        const n = Math.max(1, Math.round(len / length));
        const heading = Math.atan2(y1 - y0, x1 - x0);
        for (let k = 0; k < n; k += 1) {
          const t = (k + 0.5) / n;
          at(lv, STANCHIONS, { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, h, facing: heading - Math.PI / 2, sx: len / n / length });
        }
      }
    }
  }

  const detail: THREE.Object3D[] = [];
  for (const lv of ['up', 'down'] as const) {
    for (const [id, list] of placed[lv]) {
      const m = model(id);
      if (!m || !list.length) continue;
      // In tiles, so that what is out of view is not drawn: each tile's copies are one mesh, culled whole.
      const tiles = new Map<string, Placed[]>();
      for (const p of list) {
        const key = `${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`;
        const tile = tiles.get(key) ?? [];
        tile.push(p);
        tiles.set(key, tile);
      }
      for (const [key, tile] of tiles) {
        const mesh = propInstances(m, flat, tile, `interior-${lv}-${id}-${key}`);
        detail.push(mesh);
        groups[lv].add(mesh);
      }
    }
    groups[lv].add(solidMesh(own[lv], flat, `interior-${lv}-own`, false));
    groups[lv].visible = false;
  }

  // ---- what moves: bags and trays ---------------------------------------------------------
  const suitcase = model(SUITCASE);
  const bagColours = [0x1f2937, 0x7f1d1d, 0x1e3a8a, 0x14532d, 0x6b7280, 0x92400e, 0x312e81, 0xcbc852, 0xb94c34, 0x497aa2].map((c) => new THREE.Color(c));
  const makeBags = (count: number, name: string): THREE.InstancedMesh | null => {
    if (!suitcase) return null;
    const mesh = new THREE.InstancedMesh(suitcase.geometry, flat, count);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i += 1) mesh.setColorAt(i, bagColours[(i * 7) % bagColours.length]);
    return mesh;
  };
  const claimBags = makeBags(BAGS_ON_CAROUSEL * Math.max(1, fittings.carousels.length), 'interior-claim-bags');
  const checkinBags = makeBags(BAGS_AT_CHECKIN, 'interior-checkin-bags');
  if (claimBags) groups.down.add(claimBags);
  if (checkinBags) groups.up.add(checkinBags);
  const trayBuilder = new MeshBuilder();
  box(trayBuilder, 0, 0, 0, 0.1, 0.3, 0.22, 0, rgb(0x8f959c), rgb(0x9fa5ab));
  box(trayBuilder, 0.05, 0, 0.1, 0.3, 0.17, 0.12, 0, rgb(0x2b2f36), rgb(0x3b4049));
  const lanes = [...terminals.queues.entries()].filter(([id]) => terminals.plan.places[id].kind === 'checkpoint');
  const trayCount = lanes.reduce((n, [, q]) => n + q.servers.length * 2, 0);
  const trays = new THREE.InstancedMesh(trayBuilder.build(), flat, Math.max(1, trayCount));
  trays.name = 'interior-trays';
  trays.count = 0;
  trays.frustumCulled = false;
  trays.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  groups.up.add(trays);
  const matrix = new THREE.Matrix4();
  const loop = 2 * CAROUSEL_STRAIGHT + Math.PI * (CAROUSEL_WIDTH - 1.2);

  return {
    departures: groups.up,
    arrivals: groups.down,
    update(world: Terminals, time: number, cameraDistance = 0): void {
      const near = cameraDistance <= DETAIL_DISTANCE;
      for (const mesh of detail) mesh.visible = near;
      if (groups.down.visible && claimBags) {
        let n = 0;
        world.fittings.carousels.forEach((c, index) => {
          const waiting = Math.min(BAGS_ON_CAROUSEL, world.bagsOnCarousel(index));
          for (let k = 0; k < waiting; k += 1) {
            // Spaced round the belt, moving at half a metre a second, lying on the plates.
            const [x, y, heading] = aroundCarousel(c, (k / Math.max(waiting, 24)) * loop + time * 0.5);
            claimBags.setMatrixAt(n, placement(matrix, x, y, heightOf(c.floor) + 0.62, heading + ((k * 1.3) % 0.6) - 0.3, 0.8, 0.8, 0.8, -Math.PI / 2));
            n += 1;
          }
        });
        claimBags.count = n;
        claimBags.instanceMatrix.needsUpdate = true;
      }
      if (!groups.up.visible) return;
      if (checkinBags) {
        // Each bag dropped at a desk rides the belt behind it back to the wall, at half a metre a second.
        const drops = world.recentDrops();
        let n = 0;
        for (let i = 0; i < drops.length && n < BAGS_AT_CHECKIN; i += 4) {
          const age = time - drops[i];
          const place = world.plan.places[drops[i + 1]];
          const server = world.queues.get(place.id)?.servers[drops[i + 2]];
          if (!server || age < 0 || age > 6) continue;
          const u = Math.cos(place.heading);
          const v = Math.sin(place.heading);
          for (let b = 0; b < Math.min(3, drops[i + 3]) && n < BAGS_AT_CHECKIN; b += 1) {
            const back = DESK_FROM_PASSENGER - 0.55 + Math.max(0, age - b * 1.2) * 0.5;
            const x = server.x + u * back + v * 0.05;
            const y = server.y + v * back - u * 0.05;
            checkinBags.setMatrixAt(n, placement(matrix, x, y, upstairs + 0.55, place.heading, 0.75, 0.75, 0.75, -Math.PI / 2));
            n += 1;
          }
        }
        checkinBags.count = n;
        checkinBags.instanceMatrix.needsUpdate = true;
      }
      // Trays through the x-ray of each lane serving someone.
      let t = 0;
      for (const [id, queue] of lanes) {
        const place = world.plan.places[id];
        const u = Math.cos(place.heading);
        const v = Math.sin(place.heading);
        for (const s of queue.servers) {
          if (s.serving < 0 || t + 2 > trays.instanceMatrix.count) continue;
          const left = Math.max(0, Math.min(40, s.until - time));
          for (let k = 0; k < 2; k += 1) {
            const along = LANE.beltAlong - 3.3 + (1 - left / 40) * 6.2 - k * 0.8;
            const x = s.x + u * along - v * LANE.belt;
            const y = s.y + v * along + u * LANE.belt;
            trays.setMatrixAt(t, placement(matrix, x, y, upstairs + 0.8, place.heading - Math.PI / 2));
            t += 1;
          }
        }
      }
      trays.count = t;
      trays.instanceMatrix.needsUpdate = true;
    },
  };
}

/** The lightest (sign 1) or darkest (sign -1) colour a model is painted in. */
function extreme(m: Model, sign: number): RGB {
  const p = m.info.palette;
  let best = 0;
  for (let s = 1; s < p.length / 3; s += 1) if (sign * (p[s * 3] + p[s * 3 + 1] + p[s * 3 + 2]) > sign * (p[best * 3] + p[best * 3 + 1] + p[best * 3 + 2])) best = s;
  return [p[best * 3], p[best * 3 + 1], p[best * 3 + 2]];
}

/** A point `d` metres round a carousel's belt, on the middle of its plates, and the way the belt runs there. */
function aroundCarousel(c: Carousel, d: number): [number, number, number] {
  const straight = CAROUSEL_STRAIGHT;
  const r = CAROUSEL_WIDTH / 2 - 0.6;
  const total = 2 * straight + 2 * Math.PI * r;
  let s = ((d % total) + total) % total;
  let u: number;
  let v: number;
  let along: number;
  if (s < straight) {
    u = -straight / 2 + s;
    v = r;
    along = 0;
  } else if ((s -= straight) < Math.PI * r) {
    const a = s / r;
    u = straight / 2 + Math.sin(a) * r;
    v = Math.cos(a) * r;
    along = -a;
  } else if ((s -= Math.PI * r) < straight) {
    u = straight / 2 - s;
    v = -r;
    along = Math.PI;
  } else {
    const a = (s - straight) / r;
    u = -straight / 2 - Math.sin(a) * r;
    v = -Math.cos(a) * r;
    along = Math.PI - a;
  }
  const ux = Math.cos(c.heading);
  const uy = Math.sin(c.heading);
  return [c.x + ux * u - uy * v, c.y + uy * u + ux * v, c.heading + along];
}

/** The island between a carousel's two runs and the half circles of belt at its ends. */
function carouselEnds(b: MeshBuilder, c: Carousel, h: number, plate: RGB, base: RGB): void {
  const ux = Math.cos(c.heading);
  const uy = Math.sin(c.heading);
  const outer = CAROUSEL_WIDTH / 2;
  const inner = outer - 1.2;
  const island = rgb(0x9aa0a6);
  const islandTop = rgb(0xc9ccd0);
  box(b, c.x, c.y, h, h + 0.8, CAROUSEL_STRAIGHT / 2, inner, c.heading, island, islandTop);
  const steps = 10;
  for (const end of [1, -1]) {
    const cx = c.x + (ux * (end * CAROUSEL_STRAIGHT)) / 2;
    const cy = c.y + (uy * (end * CAROUSEL_STRAIGHT)) / 2;
    for (let i = 0; i < steps; i += 1) {
      // Round the end: from one side, through the way it points, to the other.
      const am = c.heading + (end > 0 ? 0 : Math.PI) - Math.PI / 2 + (Math.PI * (i + 0.5)) / steps;
      const half = Math.PI / steps / 2;
      // The belt's skirt and plates round the end, and the island inside them.
      box(b, cx + (Math.cos(am) * (outer + inner)) / 2, cy + (Math.sin(am) * (outer + inner)) / 2, h, h + 0.48, 0.6, outer * Math.sin(half) + 0.05, am, base, plate);
      box(b, cx + (Math.cos(am) * inner) / 2, cy + (Math.sin(am) * inner) / 2, h, h + 0.8, inner / 2, inner * Math.sin(half) + 0.05, am, island, islandTop);
    }
  }
}
