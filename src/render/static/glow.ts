// Pools of light on the ground at night: under the apron floodlights and along the lit roads.
// They are soft patches added to whatever is beneath them; the lamps themselves are in lights.ts.

import * as THREE from 'three';
import type { Airfield, Roads } from '../../shared/layout.ts';
import { roadWidth } from '../../shared/road-spec.ts';
import { MeshBuilder, ribbon, type RGB } from '../builder.ts';

const FLOOD: RGB = [1, 0.95, 0.84];
const SODIUM: RGB = [1, 0.72, 0.4];
/** Metres a road's light spills onto the verge either side together, on the ground; none from this height up. */
const SPILL = 26;
const MOTORWAY_SPILL = 10;
const SPILL_TO = 1.5;

/** White in the middle fading to nothing at the rim; its middle row is the profile across a road. */
function poolTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.62)');
  gradient.addColorStop(0.65, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface GroundGlow {
  mesh: THREE.Mesh;
  /** `night` is 0 by day and 1 in full dark. */
  set(night: number): void;
}

export function buildGroundGlow(airfield: Airfield, roads: Roads): GroundGlow {
  const b = new MeshBuilder();

  // One pool per stand, centred where the aircraft sits behind its stop point.
  for (const s of airfield.stands) {
    const reach = Math.max(42, s.span * 0.95);
    const back = reach * 0.42;
    const cx = s.x - Math.cos(s.heading) * back;
    const cy = s.y - Math.sin(s.heading) * back;
    const k = s.contact ? 0.2 : 0.12;
    const c: RGB = [FLOOD[0] * k, FLOOD[1] * k, FLOOD[2] * k];
    const p = b.vertex(cx - reach, cy - reach, 0.05, 0, 0, 1, c, 0, 0);
    const q = b.vertex(cx + reach, cy - reach, 0.05, 0, 0, 1, c, 1, 0);
    const r = b.vertex(cx + reach, cy + reach, 0.05, 0, 0, 1, c, 1, 1);
    const t = b.vertex(cx - reach, cy + reach, 0.05, 0, 0, 1, c, 0, 1);
    b.quad(p, q, r, t);
  }

  // A band of sodium light along every road that has street lamps: each road's edges joined end
  // to end where one runs on into the next, so that its light runs on round the bend instead of
  // overlapping in a bright wedge or leaving a dark one; on the ground it spills onto the verge, on
  // a deck it stays on the deck, and between the two it narrows as the road climbs.
  const lit = roads.edges.map((e) => !(e.tunnel || e.cls === 'airside' || e.cls === 'service' || e.cls === 'local'));
  const motorway = roads.edges.map((e) => e.cls.startsWith('motorway'));
  const ends = new Map<number, number[]>();
  roads.edges.forEach((e, k) => {
    if (!lit[k]) return;
    for (const node of [e.a, e.b]) (ends.get(node) ?? ends.set(node, []).get(node)!).push(k);
  });
  const used = new Set<number>();
  /** The edge that runs on from `edge` at `node`, the only other lit one there and of its kind, or -1. */
  const onward = (edge: number, node: number): number => {
    const there = ends.get(node) ?? [];
    if (there.length !== 2) return -1;
    const next = there[0] === edge ? there[1] : there[0];
    return next !== edge && !used.has(next) && motorway[next] === motorway[edge] ? next : -1;
  };
  /** An edge's points, x, y, z, from `from` to its other end, each with its glow's width. */
  const along = (k: number, from: number): { pts: number[]; widths: number[] } => {
    const e = roads.edges[k];
    const pts: number[] = [];
    const widths: number[] = [];
    const n = e.pts.length / 3;
    for (let i = 0; i < n; i += 1) {
      const j = from === e.a ? i : n - 1 - i;
      const z = e.pts[j * 3 + 2];
      pts.push(e.pts[j * 3], e.pts[j * 3 + 1], z);
      // A ramp is lit by its road's lamps, whose light already spills over it: its own stays on it.
      // A freeway's two carriageways run side by side, each's spill reaching over the other: less.
      const spill = e.cls.endsWith('_link') ? 0 : e.cls.startsWith('motorway') ? MOTORWAY_SPILL : SPILL;
      widths.push(roadWidth(e) + spill * Math.max(0, Math.min(1, (SPILL_TO - z) / SPILL_TO)));
    }
    return { pts, widths };
  };
  roads.edges.forEach((e, k) => {
    if (!lit[k] || used.has(k)) return;
    used.add(k);
    let { pts, widths } = along(k, e.a);
    // On forward from its far end, then back from its near end.
    for (let [edge, node] = [k, e.b]; ; ) {
      const next = onward(edge, node);
      if (next < 0) break;
      used.add(next);
      const more = along(next, node);
      pts = [...pts, ...more.pts.slice(3)];
      widths = [...widths, ...more.widths.slice(1)];
      [edge, node] = [next, roads.edges[next].a === node ? roads.edges[next].b : roads.edges[next].a];
    }
    for (let [edge, node] = [k, e.a]; ; ) {
      const next = onward(edge, node);
      if (next < 0) break;
      used.add(next);
      const more = along(next, roads.edges[next].a === node ? roads.edges[next].b : roads.edges[next].a);
      pts = [...more.pts.slice(0, -3), ...pts];
      widths = [...more.widths.slice(0, -1), ...widths];
      [edge, node] = [next, roads.edges[next].a === node ? roads.edges[next].b : roads.edges[next].a];
    }
    const strength = motorway[k] ? 0.12 : 0.09;
    ribbon(b, pts, 3, 0, [SODIUM[0] * strength, SODIUM[1] * strength, SODIUM[2] * strength], { lift: 0.06, widths, mitre: 0.8 });
  });

  const geometry = b.build();
  // Ribbons leave v at 0; move it to the middle row of the texture, the profile through the centre.
  const uv = geometry.attributes.uv;
  const stands = airfield.stands.length * 4;
  for (let i = stands; i < uv.count; i += 1) uv.setY(i, 0.5);

  const material = new THREE.MeshBasicMaterial({
    map: poolTexture(),
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -16,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ground-glow';
  mesh.renderOrder = 12;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  return {
    mesh,
    set(night: number): void {
      material.opacity = night;
      mesh.visible = night > 0.02;
    },
  };
}
