// Procedural textures: pavement, grass, water ripples, road lane markings and painted text.
// Everything is drawn from fixed seeds so two runs produce the same pixels.

import * as THREE from 'three';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Tileable value noise in [0, 1] on a size×size grid, summed over a few octaves. */
export function tileNoise(size: number, seed: number, octaves = 4, baseCells = 4): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o += 1) {
    const cells = baseCells << o;
    const random = lcg(seed + o * 7919);
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = random();
    for (let y = 0; y < size; y += 1) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x += 1) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = lattice[(y0 % cells) * cells + (x0 % cells)];
        const b = lattice[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = lattice[((y0 + 1) % cells) * cells + (x0 % cells)];
        const d = lattice[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        out[y * size + x] += (a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

function finish(canvas: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext('2d')!];
}

/**
 * A grey-scale detail texture centred on white, meant to multiply a vertex colour: fine grain
 * plus broad blotches, with optional slab joints. `contrast` is the total light-to-dark swing.
 */
export function detailTexture(seed: number, contrast: number, joints = 0, size = 512): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(size, size);
  const broad = tileNoise(size, seed, 4, 3);
  const fine = tileNoise(size, seed + 101, 3, 48);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i += 1) {
    const v = 1 - contrast * (0.65 * (broad[i] - 0.5) + 0.75 * (fine[i] - 0.5)) - contrast * 0.35;
    const byte = Math.max(0, Math.min(255, Math.round(v * 255)));
    image.data[i * 4] = byte;
    image.data[i * 4 + 1] = byte;
    image.data[i * 4 + 2] = byte;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  if (joints > 0) {
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    const step = size / joints;
    for (let k = 0; k < joints; k += 1) {
      ctx.beginPath();
      ctx.moveTo(k * step + 0.5, 0);
      ctx.lineTo(k * step + 0.5, size);
      ctx.moveTo(0, k * step + 0.5);
      ctx.lineTo(size, k * step + 0.5);
      ctx.stroke();
    }
  }
  return finish(canvas);
}

/** A normal map of small waves, tileable, for the bay. */
export function waterNormals(size = 256): THREE.DataTexture {
  const height = tileNoise(size, 4242, 4, 6);
  const data = new Uint8Array(size * size * 4);
  const strength = 2.2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y - 1 + size) % size) * size + x];
      const d = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength * 8;
      let ny = (u - d) * strength * 8;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export interface LaneSpec {
  /** Lanes in the direction of travel of the ribbon. */
  forward: number;
  /** Lanes the other way; 0 for a one-way road. */
  back: number;
  laneWidth: number;
  shoulder: number;
}

export const laneRibbonWidth = (s: LaneSpec): number => (s.forward + s.back) * s.laneWidth + 2 * s.shoulder;

/**
 * Road surface with its paint, one 12 m period long: solid edge lines, dashed lane lines, and a
 * double yellow line between directions. u runs left to right across the road, so with a ribbon
 * built in the direction of travel the opposing lanes are on the left.
 */
export function laneTexture(spec: LaneSpec): THREE.CanvasTexture {
  const metres = laneRibbonWidth(spec);
  const pxPerMetre = Math.min(20, 512 / metres);
  const width = Math.max(32, Math.round(metres * pxPerMetre));
  const height = 256;
  const [canvas, ctx] = makeCanvas(width, height);
  const grain = tileNoise(64, 77 + spec.forward * 13 + spec.back * 5, 3, 16);
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const g = grain[(y % 64) * 64 + (x % 64)];
      const v = 90 + Math.round((g - 0.5) * 22);
      const i = (y * width + x) * 4;
      image.data[i] = v;
      image.data[i + 1] = v + 1;
      image.data[i + 2] = v + 4;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const line = Math.max(1.5, 0.18 * pxPerMetre);
  const xAt = (metresFromLeft: number): number => metresFromLeft * pxPerMetre;
  const solid = (m: number, colour: string): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(xAt(m) - line / 2, 0, line, height);
  };
  const dashed = (m: number): void => {
    ctx.fillStyle = 'rgba(232,232,226,0.95)';
    ctx.fillRect(xAt(m) - line / 2, 0, line, height * 0.25);
  };
  const white = 'rgba(232,232,226,0.95)';
  const yellow = 'rgba(226,186,60,0.95)';
  solid(spec.shoulder, spec.back > 0 ? white : yellow);
  solid(metres - spec.shoulder, white);
  for (let k = 1; k < spec.back; k += 1) dashed(spec.shoulder + k * spec.laneWidth);
  if (spec.back > 0) {
    const centre = spec.shoulder + spec.back * spec.laneWidth;
    solid(centre - 0.16, yellow);
    solid(centre + 0.16, yellow);
  }
  for (let k = 1; k < spec.forward; k += 1) dashed(spec.shoulder + (spec.back + k) * spec.laneWidth);
  const texture = finish(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  return texture;
}

/** White or coloured text on a transparent ground, for paint on pavement and for labels. */
export function textTexture(text: string, options: { colour?: string; background?: string; font?: string; padding?: number; height?: number } = {}): { texture: THREE.CanvasTexture; aspect: number } {
  const height = options.height ?? 128;
  const padding = options.padding ?? 0.12;
  const font = options.font ?? '700 100px "Helvetica Neue", Helvetica, Arial, sans-serif';
  const [probe, pctx] = makeCanvas(8, 8);
  pctx.font = font;
  const measured = pctx.measureText(text).width * (height / 128);
  void probe;
  const width = Math.max(height, Math.ceil(measured + height * padding * 2));
  const [canvas, ctx] = makeCanvas(width, height);
  if (options.background) {
    ctx.fillStyle = options.background;
    const r = height * 0.18;
    ctx.beginPath();
    ctx.roundRect(1, 1, width - 2, height - 2, r);
    ctx.fill();
  }
  ctx.font = font.replace('100px', `${Math.round(height * 0.72)}px`);
  ctx.fillStyle = options.colour ?? '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + height * 0.04);
  const texture = finish(canvas, false);
  return { texture, aspect: width / height };
}

export interface FacadeTextures {
  /** Wall with a grid of windows; multiplies the building's own colour. u and v are in metres. */
  windows: THREE.CanvasTexture;
  /** The same grid with some windows lit, for the emissive channel at night. */
  windowsLit: THREE.CanvasTexture;
  /** Parking decks: a slab and a dark opening per level. */
  decks: THREE.CanvasTexture;
  decksLit: THREE.CanvasTexture;
  /** Terminal curtain wall: glass panels between mullions. */
  glass: THREE.CanvasTexture;
  glassLit: THREE.CanvasTexture;
}

const WINDOW_BAY = 3.5;
const FLOOR = 3.4;

/** Set a texture so one tile covers `metresU` by `metresV` when u and v are given in metres. */
function metres(texture: THREE.CanvasTexture, metresU: number, metresV: number): THREE.CanvasTexture {
  texture.repeat.set(1 / metresU, 1 / metresV);
  return texture;
}

export function facadeTextures(): FacadeTextures {
  const random = lcg(9001);

  // Windows: 4 bays by 4 floors per tile.
  const [wc, wctx] = makeCanvas(256, 256);
  wctx.fillStyle = '#ffffff';
  wctx.fillRect(0, 0, 256, 256);
  for (let floor = 0; floor < 4; floor += 1) {
    for (let bay = 0; bay < 4; bay += 1) {
      wctx.fillStyle = `rgb(${58 + Math.floor(random() * 22)},${72 + Math.floor(random() * 22)},${92 + Math.floor(random() * 24)})`;
      wctx.fillRect(bay * 64 + 10, floor * 64 + 14, 44, 30);
    }
  }
  const windows = metres(finish(wc), WINDOW_BAY * 4, FLOOR * 4);

  // Lit windows: 8 bays by 8 floors, so the pattern of lights does not visibly repeat.
  const [lc, lctx] = makeCanvas(512, 512);
  lctx.fillStyle = '#000000';
  lctx.fillRect(0, 0, 512, 512);
  for (let floor = 0; floor < 8; floor += 1) {
    for (let bay = 0; bay < 8; bay += 1) {
      if (random() > 0.42) continue;
      const warm = random();
      const level = 0.45 + random() * 0.55;
      lctx.fillStyle = `rgb(${Math.round(255 * level)},${Math.round((190 + 45 * warm) * level)},${Math.round((120 + 110 * warm) * level)})`;
      lctx.fillRect(bay * 64 + 10, floor * 64 + 14, 44, 30);
    }
  }
  const windowsLit = metres(finish(lc), WINDOW_BAY * 8, FLOOR * 8);

  // Parking decks: one level per tile height.
  const [dc, dctx] = makeCanvas(64, 64);
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(0, 0, 64, 64);
  dctx.fillStyle = '#3a3d42';
  dctx.fillRect(0, 22, 64, 30);
  dctx.fillStyle = '#d8d8d8';
  for (let k = 0; k < 4; k += 1) dctx.fillRect(k * 16, 22, 2, 30);
  const decks = metres(finish(dc), 9, 3.3);
  const [dlc, dlctx] = makeCanvas(64, 64);
  dlctx.fillStyle = '#000000';
  dlctx.fillRect(0, 0, 64, 64);
  dlctx.fillStyle = 'rgb(150,150,128)';
  dlctx.fillRect(0, 22, 64, 30);
  const decksLit = metres(finish(dlc), 9, 3.3);

  // Curtain wall: tall panes between mullions, a spandrel band at each floor.
  const [gc, gctx] = makeCanvas(256, 256);
  gctx.fillStyle = '#7fa3b8';
  gctx.fillRect(0, 0, 256, 256);
  for (let pane = 0; pane < 8; pane += 1) {
    const tint = 0.82 + random() * 0.22;
    gctx.fillStyle = `rgb(${Math.round(98 * tint)},${Math.round(140 * tint)},${Math.round(166 * tint)})`;
    gctx.fillRect(pane * 32 + 1.5, 0, 29, 256);
  }
  gctx.fillStyle = '#dfe5e8';
  for (let pane = 0; pane <= 8; pane += 1) gctx.fillRect(pane * 32 - 1.5, 0, 3, 256);
  gctx.fillRect(0, 0, 256, 20);
  const glass = metres(finish(gc), 12, 4.5);
  const [glc, glctx] = makeCanvas(256, 256);
  glctx.fillStyle = '#000000';
  glctx.fillRect(0, 0, 256, 256);
  for (let pane = 0; pane < 8; pane += 1) {
    const level = 0.55 + random() * 0.45;
    glctx.fillStyle = `rgb(${Math.round(255 * level)},${Math.round(226 * level)},${Math.round(176 * level)})`;
    glctx.fillRect(pane * 32 + 1.5, 20, 29, 236);
  }
  const glassLit = metres(finish(glc), 12, 4.5);

  return { windows, windowsLit, decks, decksLit, glass, glassLit };
}
