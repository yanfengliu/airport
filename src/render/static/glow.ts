// Pools of light on the ground at night: under the apron floodlights and along the lit roads.
// They are soft patches added to whatever is beneath them; the lamps themselves are in lights.ts.

import * as THREE from 'three';
import type { Airfield, Roads } from '../../shared/layout.ts';
import { roadWidth } from '../../shared/road-spec.ts';
import { MeshBuilder, ribbon, type RGB } from '../builder.ts';

const FLOOD: RGB = [1, 0.95, 0.84];
const SODIUM: RGB = [1, 0.72, 0.4];

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

  // A band of sodium light along every road that has street lamps.
  for (const e of roads.edges) {
    if (e.tunnel || e.cls === 'airside' || e.cls === 'service' || e.cls === 'local') continue;
    let raised = false;
    for (let i = 2; i < e.pts.length; i += 3) if (e.pts[i] > 1.5) raised = true;
    // On a deck the light stays on the deck; on the ground it spills onto the verge.
    const width = roadWidth(e) + (raised ? 0 : 26);
    const strength = e.cls.startsWith('motorway') ? 0.12 : 0.09;
    ribbon(b, e.pts, 3, width, [SODIUM[0] * strength, SODIUM[1] * strength, SODIUM[2] * strength], { lift: 0.06 });
  }

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
