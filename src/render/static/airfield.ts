// The airfield drawn on the ground: aprons, taxiways, runways and their paint.

import * as THREE from 'three';
import type { Airfield, Runway, RunwayEnd } from '../../shared/layout.ts';
import { MeshBuilder, fillPolygon, ribbon, type RGB } from '../builder.ts';
import { textTexture } from '../textures.ts';
import { ORDER, PALETTE, decalMaterial, decalMesh, grainTexture, slabTexture } from './common.ts';

const TAXIWAY_WIDTH = 23;
const TAXIWAY_SHOULDER = 40;
const STAND_PAVEMENT = 40;
const RUNWAY_SHOULDER = 7.5;
const TILE = 1 / 30;

/** A rectangle on the ground: centre, half-length along the unit vector (ux, uy), half-width across it. */
function rect(b: MeshBuilder, cx: number, cy: number, halfAlong: number, halfAcross: number, ux: number, uy: number, c: RGB): void {
  const nx = -uy;
  const ny = ux;
  const corner = (a: number, w: number): number => b.vertex(cx + ux * a + nx * w, cy + uy * a + ny * w, 0, 0, 0, 1, c);
  b.quad(corner(-halfAlong, -halfAcross), corner(halfAlong, -halfAcross), corner(halfAlong, halfAcross), corner(-halfAlong, halfAcross));
}

/** Paint for one direction of use of a runway, measured from that end's landing threshold. */
function paintRunwayEnd(b: MeshBuilder, r: Runway, from: RunwayEnd, to: RunwayEnd): void {
  const ux = (to.x - from.x) / r.length;
  const uy = (to.y - from.y) / r.length;
  const nx = -uy;
  const ny = ux;
  const white = PALETTE.paintWhite;
  const at = (along: number, across: number): [number, number] => [from.x + ux * along + nx * across, from.y + uy * along + ny * across];
  const mark = (along: number, across: number, length: number, width: number): void => {
    const [cx, cy] = at(along + length / 2, across);
    rect(b, cx, cy, length / 2, width / 2, ux, uy, white);
  };
  const t = from.displaced;

  if (t > 0) {
    // Displaced threshold: arrows up the centreline, then a bar across at the threshold.
    for (let s = 12; s + 30 < t; s += 42) {
      mark(s, 0, 24, 0.9);
      const [hx, hy] = at(s + 30, 0);
      const [lx, ly] = at(s + 22, 3.2);
      const [rx, ry] = at(s + 22, -3.2);
      const a = b.vertex(hx, hy, 0, 0, 0, 1, white);
      const l = b.vertex(lx, ly, 0, 0, 0, 1, white);
      const rr = b.vertex(rx, ry, 0, 0, 0, 1, white);
      b.tri(a, l, rr);
    }
    mark(t - 3, 0, 3, r.width - 2);
  }

  // Threshold stripes: eight each side of the centreline.
  const stripe = 1.75;
  for (let k = 0; k < 8; k += 1) {
    const across = 2.2 + stripe / 2 + k * stripe * 2;
    mark(t + 6, across, 45.7, stripe);
    mark(t + 6, -across, 45.7, stripe);
  }

  // Aiming point and touchdown zone bars.
  mark(t + 306, 15.5, 45, 9);
  mark(t + 306, -15.5, 45, 9);
  const groups: [number, number][] = [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]];
  for (const [along, bars] of groups) {
    for (let k = 0; k < bars; k += 1) {
      const across = 11 + 0.9 + k * 3.3;
      mark(t + along, across, 22.5, 1.8);
      mark(t + along, -across, 22.5, 1.8);
    }
  }
}

function paintRunway(b: MeshBuilder, r: Runway): void {
  const [e0, e1] = r.ends;
  paintRunwayEnd(b, r, e0, e1);
  paintRunwayEnd(b, r, e1, e0);
  const ux = (e1.x - e0.x) / r.length;
  const uy = (e1.y - e0.y) / r.length;
  const nx = -uy;
  const ny = ux;
  const white = PALETTE.paintWhite;
  // Centreline dashes between the two designations, and a solid stripe down each edge.
  const start = e0.displaced + 125;
  const end = r.length - e1.displaced - 125;
  for (let s = start; s + 36.5 <= end; s += 61) {
    rect(b, e0.x + ux * (s + 18.25), e0.y + uy * (s + 18.25), 18.25, 0.45, ux, uy, white);
  }
  for (const side of [1, -1]) {
    const across = side * (r.width / 2 - 1.2);
    const mid = r.length / 2;
    rect(b, e0.x + ux * mid + nx * across, e0.y + uy * mid + ny * across, (r.length - e0.displaced - e1.displaced) / 2, 0.45, ux, uy, white);
  }
}

/** A textured quad lying on the ground whose text reads upright looking along `upHeading`. */
function groundText(text: string, cx: number, cy: number, height: number, upHeading: number, colour: string): THREE.Mesh {
  const { texture, aspect } = textTexture(text, { colour, padding: 0.02 });
  const width = height * aspect;
  const ux = Math.cos(upHeading);
  const uy = Math.sin(upHeading);
  const rx = uy;
  const ry = -ux;
  const corners: [number, number][] = [
    [cx - (rx * width) / 2 - (ux * height) / 2, cy - (ry * width) / 2 - (uy * height) / 2],
    [cx + (rx * width) / 2 - (ux * height) / 2, cy + (ry * width) / 2 - (uy * height) / 2],
    [cx + (rx * width) / 2 + (ux * height) / 2, cy + (ry * width) / 2 + (uy * height) / 2],
    [cx - (rx * width) / 2 + (ux * height) / 2, cy - (ry * width) / 2 + (uy * height) / 2],
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(([x, y]) => [x, 0, -y]), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, alphaTest: 0.25 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = ORDER.paintText;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function buildAirfieldGround(airfield: Airfield): THREE.Group {
  const group = new THREE.Group();
  group.name = 'airfield';

  // ---- pavement -------------------------------------------------------------------------
  const apron = new MeshBuilder();
  for (const a of airfield.aprons) fillPolygon(apron, a.poly, 0, PALETTE.apron, TILE);
  for (const e of airfield.edges) if (e.kind === 'stand') ribbon(apron, e.pts, 2, STAND_PAVEMENT, PALETTE.apron, { vLength: STAND_PAVEMENT });
  const slab = slabTexture();
  group.add(decalMesh(apron, ORDER.apron, decalMaterial({ map: slab }), 'aprons'));

  const shoulder = new MeshBuilder();
  const taxi = new MeshBuilder();
  for (const e of airfield.edges) {
    if (e.kind !== 'twy') continue;
    ribbon(shoulder, e.pts, 2, TAXIWAY_SHOULDER, PALETTE.taxiShoulder, { vLength: TAXIWAY_SHOULDER });
    ribbon(taxi, e.pts, 2, TAXIWAY_WIDTH, PALETTE.taxiway, { vLength: TAXIWAY_WIDTH });
  }
  group.add(decalMesh(shoulder, ORDER.taxiShoulder, decalMaterial({ map: grainTexture() }), 'taxiway-shoulders'));
  group.add(decalMesh(taxi, ORDER.taxiway, decalMaterial({ map: slab }), 'taxiways'));

  const runwayShoulder = new MeshBuilder();
  const runway = new MeshBuilder();
  for (const s of airfield.stopways) {
    if (s.length >= 6) fillPolygon(runwayShoulder, { outer: s }, 0, PALETTE.blastPad, TILE);
  }
  for (const r of airfield.runways) {
    const line = [r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y];
    ribbon(runwayShoulder, line, 2, r.width + 2 * RUNWAY_SHOULDER, PALETTE.runwayShoulder, { vLength: r.width });
    ribbon(runway, line, 2, r.width, PALETTE.runway, { vLength: r.width });
  }
  group.add(decalMesh(runwayShoulder, ORDER.runwayShoulder, decalMaterial({ map: grainTexture() }), 'runway-shoulders'));
  group.add(decalMesh(runway, ORDER.runway, decalMaterial({ map: grainTexture() }), 'runways'));

  // ---- paint ----------------------------------------------------------------------------
  const paint = new MeshBuilder();
  for (const r of airfield.runways) paintRunway(paint, r);
  for (const e of airfield.edges) {
    if (e.kind === 'rwy') continue;
    ribbon(paint, e.pts, 2, e.kind === 'twy' ? 0.5 : 0.4, PALETTE.paintYellow);
  }
  // Hold bars: a solid bar and a dashed one across the taxiway at each holding position.
  const direction = new Map<number, [number, number]>();
  for (const e of airfield.edges) {
    if (e.kind !== 'twy') continue;
    const n = e.pts.length;
    if (!direction.has(e.a)) direction.set(e.a, [e.pts[2] - e.pts[0], e.pts[3] - e.pts[1]]);
    if (!direction.has(e.b)) direction.set(e.b, [e.pts[n - 2] - e.pts[n - 4], e.pts[n - 1] - e.pts[n - 3]]);
  }
  airfield.nodes.forEach((node, index) => {
    if (!node.hold) return;
    const d = direction.get(index);
    if (!d) return;
    const len = Math.hypot(d[0], d[1]) || 1;
    const ux = d[0] / len;
    const uy = d[1] / len;
    rect(paint, node.x, node.y, 0.45, TAXIWAY_WIDTH / 2, ux, uy, PALETTE.paintYellow);
    for (let k = -4; k <= 4; k += 1) {
      rect(paint, node.x + ux * 1.5 - uy * k * 2.4, node.y + uy * 1.5 + ux * k * 2.4, 0.45, 0.6, ux, uy, PALETTE.paintYellow);
    }
  });
  group.add(decalMesh(paint, ORDER.paint, decalMaterial(), 'airfield-paint'));

  // Runway designations: the letter nearer the threshold, the number beyond it.
  for (const r of airfield.runways) {
    for (const [from, to] of [[r.ends[0], r.ends[1]], [r.ends[1], r.ends[0]]] as const) {
      const ux = (to.x - from.x) / r.length;
      const uy = (to.y - from.y) / r.length;
      const up = Math.atan2(uy, ux);
      const digits = from.name.replace(/[LRC]$/, '');
      const letter = /[LRC]$/.exec(from.name)?.[0];
      let along = from.displaced + 64;
      if (letter) {
        group.add(groundText(letter, from.x + ux * (along + 9.15), from.y + uy * (along + 9.15), 18.3, up, '#e6e6e0'));
        along += 24;
      }
      group.add(groundText(digits, from.x + ux * (along + 9.15), from.y + uy * (along + 9.15), 18.3, up, '#e6e6e0'));
    }
  }
  return group;
}
