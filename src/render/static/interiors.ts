// Inside the terminals, for the cut-away view: the floor of each level, the rooms on it tinted by
// what they are for, the desks, lanes, booths and podiums where people queue, and the baggage
// belts with bags going round. One group per level; the view shows one at a time.

import * as THREE from 'three';
import type { AreaKind, Layout, PolygonData } from '../../shared/layout.ts';
import { FLOOR, FLOOR_HEIGHT, type Place } from '../../sim/terminal/plan.ts';
import type { Terminals } from '../../sim/terminal/terminals.ts';
import { MeshBuilder, box, fillPolygon, rgb, wallPolygon, type RGB } from '../builder.ts';
import { ORDER, solidMesh } from './common.ts';

const SLAB: RGB = rgb(0xd8d3c8);
const LOWER_SLAB: RGB = rgb(0xcfc8ba);
const EDGE: RGB = rgb(0x8f959c);
const ROOM: Partial<Record<AreaKind, RGB>> = {
  checkin: rgb(0xe9d8a6),
  security: rgb(0xe7b9b4),
  claim: rgb(0xb3d1e4),
  customs: rgb(0xcdb9e6),
  gate: rgb(0xc4ddc2),
  food: rgb(0xebcfae),
  shop: rgb(0xe4c3dc),
  lounge: rgb(0xc3c6e8),
  toilets: rgb(0xc5cbd1),
};
/** Rooms of these kinds are on the arrivals level; everything else is upstairs. */
const DOWNSTAIRS = new Set<AreaKind>(['claim']);
const METAL: RGB = rgb(0x5b6168);
const DESK: RGB = rgb(0x8a6d4f);
const BELT: RGB = rgb(0x3a3f45);

/** A belt is a loop this long and this wide, metres. */
const BELT_LENGTH = 22;
const BELT_WIDTH = 6;
const BAGS_SHOWN = 80;

export interface Interiors {
  departures: THREE.Group;
  arrivals: THREE.Group;
  /** Move the bags round the belts; `seconds` is running time. */
  update(terminals: Terminals, seconds: number): void;
}

/** A point `d` metres round a stadium-shaped loop centred on (x, y), along `heading`. */
function aroundBelt(x: number, y: number, heading: number, d: number): [number, number] {
  const straight = BELT_LENGTH - BELT_WIDTH;
  const r = BELT_WIDTH / 2;
  const total = 2 * straight + 2 * Math.PI * r;
  let s = ((d % total) + total) % total;
  let u: number;
  let v: number;
  if (s < straight) {
    u = -straight / 2 + s;
    v = r;
  } else if ((s -= straight) < Math.PI * r) {
    const a = s / r;
    u = straight / 2 + Math.sin(a) * r;
    v = Math.cos(a) * r;
  } else if ((s -= Math.PI * r) < straight) {
    u = straight / 2 - s;
    v = -r;
  } else {
    const a = (s - straight) / r;
    u = -straight / 2 - Math.sin(a) * r;
    v = -Math.cos(a) * r;
  }
  const c = Math.cos(heading);
  const sn = Math.sin(heading);
  return [x + c * u - sn * v, y + sn * u + c * v];
}

export function buildInteriors(layout: Layout, terminals: Terminals): Interiors {
  const upstairs = FLOOR_HEIGHT[FLOOR.landside];
  const downstairs = FLOOR_HEIGHT[FLOOR.arrivals];
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Rooms are painted on the floor: they keep to the floor's depth and do not write their own.
  const roomMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const make = (name: string, level: number, slab: RGB, rooms: (kind: AreaKind) => boolean): { group: THREE.Group; props: MeshBuilder } => {
    const floor = new MeshBuilder();
    const props = new MeshBuilder();
    for (const b of layout.terminals.buildings) {
      fillPolygon(floor, b.poly, level - 0.05, slab);
      // A low wall round the edge, so the plan reads.
      wallPolygon(floor, b.poly, level - 0.05, level + 1.1, EDGE);
    }
    // The rooms are mapped on several levels of the building and all shown on this one floor: one
    // mesh per mapped level, drawn over the floor in order of level, so that where two overlap in
    // plan the upper one shows, every frame, instead of the two flickering.
    const byLevel = new Map<number, MeshBuilder>();
    for (const a of layout.terminals.areas) {
      const colour = ROOM[a.kind];
      if (!colour || !rooms(a.kind)) continue;
      const mapped = a.level ?? 0;
      let builder = byLevel.get(mapped);
      if (!builder) byLevel.set(mapped, (builder = new MeshBuilder()));
      fillPolygon(builder, a.poly as PolygonData, level + 0.02, colour);
    }
    const group = new THREE.Group();
    group.name = name;
    // Drawn after the paint on the ground: the paint is pulled towards the camera so the layers on
    // the ground do not fight, and from far off that is enough to cover a floor half a metre up.
    const floorMesh = solidMesh(floor, material, `${name}-floor`, false);
    floorMesh.renderOrder = ORDER.paintText + 1;
    group.add(floorMesh);
    [...byLevel.keys()].sort((p, q) => p - q).forEach((mapped, rank) => {
      const mesh = new THREE.Mesh(byLevel.get(mapped)!.build(), roomMaterial);
      mesh.name = `${name}-rooms-${mapped}`;
      mesh.renderOrder = ORDER.paintText + 2 + rank;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    });
    group.visible = false;
    return { group, props };
  };
  const up = make('interior-departures', upstairs, SLAB, (k) => !DOWNSTAIRS.has(k));
  const down = make('interior-arrivals', downstairs, LOWER_SLAB, (k) => DOWNSTAIRS.has(k));

  // Desks, lanes and booths at each queue's servers.
  for (const [placeId, queue] of terminals.queues) {
    const place = terminals.plan.places[placeId];
    const h = FLOOR_HEIGHT[place.floor];
    const target = place.floor === FLOOR.arrivals ? down.props : up.props;
    const ux = Math.cos(place.heading);
    const uy = Math.sin(place.heading);
    for (const s of queue.servers) {
      if (place.kind === 'checkpoint') {
        // The x-ray belt beside the lane, and the arch to walk through.
        box(target, s.x + ux * 2.2 + -uy * 0.7, s.y + uy * 2.2 + ux * 0.7, h, h + 1.1, 1.6, 0.4, place.heading, METAL, METAL);
        box(target, s.x + ux * 3.4, s.y + uy * 3.4, h, h + 2.1, 0.1, 0.5, place.heading, METAL, METAL);
      } else if (place.kind === 'checkin') {
        box(target, s.x + ux * 1.1, s.y + uy * 1.1, h, h + 1.05, 0.4, 0.8, place.heading, DESK, DESK);
      } else if (place.kind === 'customs') {
        box(target, s.x + ux * 1.2, s.y + uy * 1.2, h, h + 1.25, 0.7, 0.6, place.heading, METAL, DESK);
      } else if (place.kind === 'holdroom') {
        box(target, s.x + ux * 0.8, s.y + uy * 0.8, h, h + 1.1, 0.35, 0.5, place.heading, DESK, DESK);
      }
    }
  }

  // Belts in the claim halls.
  const claims: Place[] = [...new Set([...terminals.plan.claim.values()].flatMap((c) => [c.domestic, c.international]))];
  for (const claim of claims) {
    const steps = 40;
    let prev: [number, number] | null = null;
    for (let i = 0; i <= steps; i += 1) {
      const p = aroundBelt(claim.x, claim.y, claim.heading, (i / steps) * (2 * (BELT_LENGTH - BELT_WIDTH) + Math.PI * BELT_WIDTH));
      if (prev) {
        const mx = (p[0] + prev[0]) / 2;
        const my = (p[1] + prev[1]) / 2;
        const len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        box(down.props, mx, my, downstairs, downstairs + 0.45, len / 2 + 0.05, 0.6, Math.atan2(p[1] - prev[1], p[0] - prev[0]), BELT, BELT);
      }
      prev = p;
    }
  }
  up.group.add(solidMesh(up.props, material, 'interior-departures-props'));
  down.group.add(solidMesh(down.props, material, 'interior-arrivals-props'));

  // Bags: small boxes on the belts, as many as are waiting there.
  const bagGeometry = new MeshBuilder();
  box(bagGeometry, 0, 0, 0, 0.42, 0.35, 0.23, 0, rgb(0xffffff), rgb(0xffffff));
  const bags = new THREE.InstancedMesh(bagGeometry.build(), new THREE.MeshLambertMaterial({ color: 0xffffff }), BAGS_SHOWN * Math.max(1, claims.length));
  bags.count = 0;
  bags.frustumCulled = false;
  bags.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bags.setColorAt(0, new THREE.Color(0xffffff));
  down.group.add(bags);
  const colours = [0x1f2937, 0x7f1d1d, 0x1e3a8a, 0x14532d, 0x6b7280, 0x92400e, 0x312e81, 0x0f172a].map((c) => new THREE.Color(c));
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const up3 = new THREE.Vector3(0, 1, 0);
  let lastCount = -1;

  return {
    departures: up.group,
    arrivals: down.group,
    update(world: Terminals, seconds: number): void {
      if (!down.group.visible) return;
      let n = 0;
      const loop = 2 * (BELT_LENGTH - BELT_WIDTH) + Math.PI * BELT_WIDTH;
      for (const claim of claims) {
        const waiting = Math.min(BAGS_SHOWN, world.bagsOnBelt(claim));
        for (let k = 0; k < waiting; k += 1) {
          // Spaced round the belt, moving at half a metre a second.
          const [x, y] = aroundBelt(claim.x, claim.y, claim.heading, (k / Math.max(waiting, 30)) * loop + seconds * 0.5);
          position.set(x, downstairs + 0.45, -y);
          quaternion.setFromAxisAngle(up3, (k * 1.7) % Math.PI);
          matrix.compose(position, quaternion, scale);
          bags.setMatrixAt(n, matrix);
          if (lastCount < 0) bags.setColorAt(n, colours[(n * 5) % colours.length]);
          n += 1;
        }
      }
      if (lastCount < 0) {
        for (let i = 0; i < bags.instanceMatrix.count; i += 1) bags.setColorAt(i, colours[(i * 5) % colours.length]);
        if (bags.instanceColor) bags.instanceColor.needsUpdate = true;
      }
      lastCount = n;
      bags.count = n;
      bags.instanceMatrix.needsUpdate = true;
    },
  };
}
