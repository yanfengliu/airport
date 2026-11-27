// Points of light: runway, taxiway and approach lights, street lamps, and the lights carried by
// aircraft and vehicles. One shader draws them all as soft glowing dots that keep a minimum size
// on screen, flash if told to, and fade with haze. They come up as daylight goes.

import * as THREE from 'three';
import type { Airfield, Land, Roads } from '../shared/layout.ts';

const vertexShader = /* glsl */ `
  attribute vec3 colour;
  attribute float size;
  attribute vec3 flash;
  uniform float uTime;
  uniform float uScale;
  uniform float uNight;
  uniform float uFog;
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float distance = -mv.z;
    float on = 1.0;
    if (flash.x > 0.0) on = step(fract((uTime - flash.z) / flash.x), flash.y);
    float fog = exp(-uFog * uFog * distance * distance);
    // Size in pixels: true size when near, never smaller than a dot when far.
    float px = size * uScale / max(1.0, distance);
    float shown = max(px, 2.0);
    // A light too small to resolve dims instead of vanishing.
    float dim = clamp(px / 2.0, 0.4, 1.0);
    gl_PointSize = min(shown, 96.0);
    gl_Position = projectionMatrix * mv;
    vColour = colour;
    vAlpha = on * uNight * fog * dim;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float glow = (1.0 - r2);
    glow = glow * glow;
    float core = smoothstep(0.35, 0.0, r2);
    gl_FragColor = vec4(vColour * (glow * 1.3 + core * 1.5) * vAlpha, 1.0);
  }
`;

function makeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uTime: { value: 0 }, uScale: { value: 800 }, uNight: { value: 0 }, uFog: { value: 0.00004 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
  });
}

/** Collects lights given in map coordinates (x east, y north, h up). */
class LightList {
  readonly positions: number[] = [];
  readonly colours: number[] = [];
  readonly sizes: number[] = [];
  readonly flashes: number[] = [];

  add(x: number, y: number, h: number, colour: readonly [number, number, number], size: number, period = 0, duty = 0, offset = 0): void {
    this.positions.push(x, h, -y);
    this.colours.push(colour[0], colour[1], colour[2]);
    this.sizes.push(size);
    this.flashes.push(period, duty, offset);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('colour', new THREE.Float32BufferAttribute(this.colours, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(this.sizes, 1));
    g.setAttribute('flash', new THREE.Float32BufferAttribute(this.flashes, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE: [number, number, number] = [1, 0.96, 0.86];
const COLD: [number, number, number] = [0.86, 0.93, 1];
const RED: [number, number, number] = [1, 0.12, 0.08];
const GREEN: [number, number, number] = [0.15, 1, 0.35];
const BLUE: [number, number, number] = [0.2, 0.42, 1];
const AMBER: [number, number, number] = [1, 0.72, 0.2];
const SODIUM: [number, number, number] = [1, 0.74, 0.42];

/** Points every `spacing` metres along a polyline of x, y pairs, offset sideways by `offset`. */
function along(pts: readonly number[], stride: number, spacing: number, offset: number, each: (x: number, y: number, h: number, distance: number) => void): void {
  let carried = spacing / 2;
  let run = 0;
  for (let i = stride; i < pts.length; i += stride) {
    const x0 = pts[i - stride];
    const y0 = pts[i - stride + 1];
    const x1 = pts[i];
    const y1 = pts[i + 1];
    const h0 = stride === 3 ? pts[i - 1] : 0;
    const h1 = stride === 3 ? pts[i + 2] : 0;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.01) continue;
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    for (let s = spacing - carried; s <= len; s += spacing) {
      const t = s / len;
      each(x0 + (x1 - x0) * t + nx * offset, y0 + (y1 - y0) * t + ny * offset, h0 + (h1 - h0) * t, run + s);
    }
    carried = (carried + len) % spacing;
    run += len;
  }
}

export interface DynamicLight {
  x: number;
  y: number;
  h: number;
  colour: readonly [number, number, number];
  size: number;
  period?: number;
  duty?: number;
  offset?: number;
}

export class Lights {
  readonly group = new THREE.Group();
  private readonly material = makeMaterial();
  private readonly dynamic: THREE.Points;
  private readonly capacity: number;
  private used = 0;

  /**
   * `floodlights`: where the gates' floodlights are, on their masts or the terminal's roof, when
   * the airfield's furniture is drawn; without it each hangs ahead of its gate's stop point.
   */
  constructor(airfield: Airfield, roads: Roads, land: Land, capacity = 24_000, floodlights: readonly { x: number; y: number; h: number }[] | null = null) {
    this.group.name = 'lights';
    this.capacity = capacity;
    const list = new LightList();

    // ---- runways ------------------------------------------------------------------------
    for (const r of airfield.runways) {
      const [a, b] = r.ends;
      const ux = (b.x - a.x) / r.length;
      const uy = (b.y - a.y) / r.length;
      const nx = -uy;
      const ny = ux;
      const half = r.width / 2 - 0.5;
      for (let s = 0; s <= r.length; s += 60) {
        // Edge lights are white, amber over the last 600 m as seen from either end.
        const nearEnd = Math.min(s, r.length - s) < 600;
        for (const side of [1, -1]) list.add(a.x + ux * s + nx * half * side, a.y + uy * s + ny * half * side, 0.4, nearEnd ? AMBER : WHITE, 2.6);
      }
      for (let s = 30; s < r.length; s += 30) list.add(a.x + ux * s, a.y + uy * s, 0.15, COLD, 1.5);
      for (const [end, dir] of [[a, 1], [b, -1]] as const) {
        const tx = end.x + ux * dir * end.displaced;
        const ty = end.y + uy * dir * end.displaced;
        for (let k = -9; k <= 9; k += 1) {
          // Green bar at the landing threshold, red bar at the very end of the pavement.
          list.add(tx + nx * k * 3.1, ty + ny * k * 3.1, 0.4, GREEN, 2.8);
          list.add(end.x + nx * k * 3.1, end.y + ny * k * 3.1, 0.4, RED, 2.6);
        }
        // Touchdown zone: rows of three either side of the centreline for 900 m.
        for (let s = 30; s <= 900; s += 60) {
          for (const side of [1, -1]) for (let k = 0; k < 3; k += 1) list.add(tx + ux * dir * s + nx * side * (11 + k * 1.5), ty + uy * dir * s + ny * side * (11 + k * 1.5), 0.15, WHITE, 1.4);
        }
        // Approach lights: bars every 30 m out to 720 m, with a chasing flash down the last of them.
        for (let s = 30; s <= 720; s += 30) {
          const px = tx - ux * dir * s;
          const py = ty - uy * dir * s;
          for (let k = -2; k <= 2; k += 1) list.add(px + nx * k * 1.4, py + ny * k * 1.4, 2.8, WHITE, 2.4);
          if (s === 300) for (let k = -7; k <= 7; k += 1) list.add(px + nx * k * 2.2, py + ny * k * 2.2, 2.8, WHITE, 2.4);
          if (s > 300) list.add(px, py, 3.2, COLD, 5.5, 0.55, 0.07, 0.55 * (1 - (s - 300) / 420));
        }
      }
    }

    // ---- taxiways -----------------------------------------------------------------------
    for (const e of airfield.edges) {
      if (e.kind !== 'twy') continue;
      along(e.pts, 2, 30, 11.5, (x, y) => list.add(x, y, 0.35, BLUE, 1.9));
      along(e.pts, 2, 30, -11.5, (x, y) => list.add(x, y, 0.35, BLUE, 1.9));
      along(e.pts, 2, 15, 0, (x, y) => list.add(x, y, 0.1, GREEN, 1.1));
    }
    for (const n of airfield.nodes) if (n.hold) for (const k of [-1, 0, 1]) list.add(n.x + k * 3, n.y, 0.3, RED, 2);

    // ---- stands: a floodlight on each gate's mast, or ahead of its stop point --------------
    if (floodlights) for (const f of floodlights) list.add(f.x, f.y, f.h, WHITE, 9);
    else {
      for (const s of airfield.stands) {
        if (!s.contact) continue;
        list.add(s.x + Math.cos(s.heading) * 14, s.y + Math.sin(s.heading) * 14, 18, WHITE, 9);
      }
    }

    // ---- approach-light piers in the bay --------------------------------------------------
    for (const pier of land.piers) along(pier, 2, 30, 0, (x, y) => list.add(x, y, 3.4, WHITE, 2.2));

    // ---- street lighting on the bigger roads ----------------------------------------------
    for (const e of roads.edges) {
      if (e.tunnel || e.cls === 'airside' || e.cls === 'service' || e.cls === 'local') continue;
      const spacing = e.cls.startsWith('motorway') ? 55 : 42;
      const side = (e.lanes + e.back) * 1.9 + 2;
      along(e.pts, 3, spacing, side, (x, y, h) => list.add(x, y, h + 9, SODIUM, 5));
    }

    const fixed = new THREE.Points(list.geometry(), this.material);
    fixed.name = 'fixed-lights';
    fixed.frustumCulled = false;
    fixed.renderOrder = 20;
    this.group.add(fixed);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('colour', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('flash', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.dynamic = new THREE.Points(g, this.material);
    this.dynamic.name = 'moving-lights';
    this.dynamic.frustumCulled = false;
    this.dynamic.renderOrder = 21;
    this.group.add(this.dynamic);
  }

  /** Start a new frame's worth of moving lights. */
  begin(): void {
    this.used = 0;
  }

  /** Add one moving light for this frame, in map coordinates. */
  add(x: number, y: number, h: number, colour: readonly [number, number, number], size: number, period = 0, duty = 0, offset = 0): void {
    if (this.used >= this.capacity) return;
    const g = this.dynamic.geometry;
    const i = this.used;
    const k = i * 3;
    // Written element by element: thousands of these a frame must not each make an array.
    const position = g.attributes.position.array as Float32Array;
    position[k] = x;
    position[k + 1] = h;
    position[k + 2] = -y;
    const tint = g.attributes.colour.array as Float32Array;
    tint[k] = colour[0];
    tint[k + 1] = colour[1];
    tint[k + 2] = colour[2];
    (g.attributes.size.array as Float32Array)[i] = size;
    const flash = g.attributes.flash.array as Float32Array;
    flash[k] = period;
    flash[k + 1] = duty;
    flash[k + 2] = offset;
    this.used += 1;
  }

  /** Finish the frame: `night` is 0 by day and 1 in full dark; `seconds` drives the flashing. */
  end(seconds: number, night: number, viewportHeight: number, fovDegrees: number, fogDensity: number): void {
    const g = this.dynamic.geometry;
    g.setDrawRange(0, this.used);
    for (const name of ['position', 'colour', 'size', 'flash'] as const) g.attributes[name].needsUpdate = true;
    const u = this.material.uniforms;
    u.uTime.value = seconds;
    u.uNight.value = night;
    u.uScale.value = viewportHeight / (2 * Math.tan((fovDegrees * Math.PI) / 360));
    u.uFog.value = fogDensity;
    this.group.visible = night > 0.02;
  }
}

export const LIGHT_COLOURS = { WHITE, COLD, RED, GREEN, BLUE, AMBER, SODIUM };
