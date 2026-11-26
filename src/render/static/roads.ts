// Roads: painted on the ground where they are at grade, built as decks on piers where they fly.

import * as THREE from 'three';
import type { RoadClass, RoadEdge, Roads } from '../../shared/layout.ts';
import { MeshBuilder, disc, ribbon, shade, type RGB } from '../builder.ts';
import { laneRibbonWidth, laneTexture, type LaneSpec } from '../textures.ts';
import { ORDER, PALETTE, decalMaterial, decalMesh, grainTexture, solidMesh } from './common.ts';
import { deck, piers } from './structures.ts';

const LANE_WIDTH: Record<RoadClass, number> = {
  motorway: 3.7,
  motorway_link: 3.9,
  trunk: 3.6,
  primary: 3.5,
  secondary: 3.4,
  tertiary: 3.3,
  local: 3.2,
  service: 3,
  airside: 3,
};

const SHOULDER: Record<RoadClass, number> = {
  motorway: 2.6,
  motorway_link: 1.6,
  trunk: 1.2,
  primary: 0.8,
  secondary: 0.6,
  tertiary: 0.5,
  local: 0.4,
  service: 0.3,
  airside: 0.3,
};

/** Classes drawn as plain asphalt, without lane paint. */
const PLAIN = new Set<RoadClass>(['local', 'service', 'airside']);
const ELEVATED_FROM = 0.6;

export function laneSpec(e: RoadEdge): LaneSpec {
  return { forward: e.lanes, back: e.back, laneWidth: LANE_WIDTH[e.cls], shoulder: SHOULDER[e.cls] };
}

export function roadWidth(e: RoadEdge): number {
  return laneRibbonWidth(laneSpec(e));
}

const maxZ = (e: RoadEdge): number => {
  let z = 0;
  for (let i = 2; i < e.pts.length; i += 3) z = Math.max(z, e.pts[i]);
  return z;
};

export function buildRoads(roads: Roads): THREE.Group {
  const group = new THREE.Group();
  group.name = 'roads';

  const casing = new MeshBuilder();
  const plain = new MeshBuilder();
  const plainDeck = new MeshBuilder();
  const junction = new MeshBuilder();
  const structure = new MeshBuilder();
  const painted = new Map<string, { spec: LaneSpec; ground: MeshBuilder; raised: MeshBuilder }>();
  const concrete = PALETTE.concrete;
  const white: RGB = [1, 1, 1];

  const elevated = roads.edges.map((e) => maxZ(e) > ELEVATED_FROM);
  roads.edges.forEach((e, index) => {
    if (e.tunnel) return;
    const spec = laneSpec(e);
    const width = laneRibbonWidth(spec);
    const up = elevated[index];
    if (up) {
      deck(structure, e.pts, width, concrete);
      piers(structure, e.pts, width, concrete);
    }
    if (PLAIN.has(e.cls)) {
      const tone = e.cls === 'airside' ? shade(PALETTE.asphalt, 1.25) : PALETTE.asphalt;
      if (up) ribbon(plainDeck, e.pts, 3, width, tone, { vLength: width, lift: 0.12 });
      else {
        if (e.cls === 'local') ribbon(casing, e.pts, 3, width + 2.4, PALETTE.roadCasing);
        ribbon(plain, e.pts, 3, width, tone, { vLength: width });
      }
      return;
    }
    const key = `${spec.forward}|${spec.back}|${spec.laneWidth}|${spec.shoulder}`;
    let entry = painted.get(key);
    if (!entry) {
      entry = { spec, ground: new MeshBuilder(), raised: new MeshBuilder() };
      painted.set(key, entry);
    }
    if (up) ribbon(entry.raised, e.pts, 3, width, white, { vLength: 12, lift: 0.12 });
    else {
      if (!e.cls.startsWith('motorway')) ribbon(casing, e.pts, 3, width + 2.4, PALETTE.roadCasing);
      ribbon(entry.ground, e.pts, 3, width, white, { vLength: 12 });
    }
  });

  // Plain asphalt where surface streets meet, so lane paint does not run through the junction.
  const incident = new Map<number, RoadEdge[]>();
  roads.edges.forEach((e) => {
    for (const end of [e.a, e.b]) (incident.get(end) ?? incident.set(end, []).get(end)!).push(e);
  });
  for (const [index, list] of incident) {
    const node = roads.nodes[index];
    if (list.length < 3 || node.z > ELEVATED_FROM) continue;
    if (list.some((e) => e.cls.startsWith('motorway') || e.tunnel || PLAIN.has(e.cls))) continue;
    const widths = list.map(roadWidth).sort((p, q) => q - p);
    disc(junction, node.x, node.y, 0, Math.min(widths[0], widths[1] + 2) / 2, PALETTE.asphalt);
  }

  const grain = grainTexture();
  group.add(decalMesh(casing, ORDER.roadCasing, decalMaterial(), 'road-casing'));
  group.add(decalMesh(plain, ORDER.road, decalMaterial({ map: grain }), 'road-plain'));
  group.add(decalMesh(junction, ORDER.junction, decalMaterial({ map: grain }), 'road-junctions'));
  const deckMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  group.add(solidMesh(structure, deckMaterial, 'road-structures'));
  group.add(solidMesh(plainDeck, new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 0.95 }), 'road-plain-decks', false));
  for (const [key, entry] of painted) {
    const texture = laneTexture(entry.spec);
    if (entry.ground.vertexCount) group.add(decalMesh(entry.ground, ORDER.road, decalMaterial({ map: texture }), `road-${key}`));
    if (entry.raised.vertexCount) group.add(solidMesh(entry.raised, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.92, metalness: 0 }), `road-deck-${key}`, false));
  }
  return group;
}
