// Elevated structures shared by roads and rail: the deck that carries them and its piers.

import { MeshBuilder, box, shade, type RGB } from '../builder.ts';

export const DECK_THICKNESS = 1.3;
/** Below this height a structure is drawn as a solid ramp down to the ground. */
export const PIER_FROM = 3.6;

/**
 * Sides, underside and parapets of a deck following a polyline of (x, y, z) triples. The running
 * surface itself is drawn by the caller, at z plus a small lift.
 */
export function deck(b: MeshBuilder, pts: readonly number[], width: number, c: RGB, parapet = 1.05): void {
  const n = pts.length / 3;
  const half = width / 2 + 0.25;
  let prev: number[] | null = null;
  for (let i = 0; i < n; i += 1) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    const p = Math.max(0, i - 1);
    const q = Math.min(n - 1, i + 1);
    let tx = pts[q * 3] - pts[p * 3];
    let ty = pts[q * 3 + 1] - pts[p * 3 + 1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const lx = -ty;
    const ly = tx;
    const top = z + parapet;
    const bottom = z > PIER_FROM ? z - DECK_THICKNESS : Math.min(0, z - DECK_THICKNESS);
    const dark = shade(c, 0.7);
    const ring = [
      b.vertex(x + lx * half, y + ly * half, top, lx, ly, 0, c),
      b.vertex(x + lx * half, y + ly * half, bottom, lx, ly, 0, c),
      b.vertex(x - lx * half, y - ly * half, top, -lx, -ly, 0, c),
      b.vertex(x - lx * half, y - ly * half, bottom, -lx, -ly, 0, c),
      b.vertex(x + lx * half, y + ly * half, bottom, 0, 0, -1, dark),
      b.vertex(x - lx * half, y - ly * half, bottom, 0, 0, -1, dark),
      // Inside faces of the parapets, so the barrier reads from the roadway.
      b.vertex(x + lx * (half - 0.25), y + ly * (half - 0.25), top, -lx, -ly, 0, c),
      b.vertex(x + lx * (half - 0.25), y + ly * (half - 0.25), z + 0.1, -lx, -ly, 0, c),
      b.vertex(x - lx * (half - 0.25), y - ly * (half - 0.25), top, lx, ly, 0, c),
      b.vertex(x - lx * (half - 0.25), y - ly * (half - 0.25), z + 0.1, lx, ly, 0, c),
    ];
    if (prev) {
      // Each quad is wound counter-clockwise as seen from the side its normal points to.
      b.quad(ring[1], prev[1], prev[0], ring[0]);
      b.quad(prev[3], ring[3], ring[2], prev[2]);
      b.quad(prev[4], ring[4], ring[5], prev[5]);
      b.quad(prev[7], ring[7], ring[6], prev[6]);
      b.quad(ring[9], prev[9], prev[8], ring[8]);
    }
    prev = ring;
  }
}

/** Columns under a deck, one bent every `spacing` metres wherever it is high enough to need them. */
export function piers(b: MeshBuilder, pts: readonly number[], width: number, c: RGB, spacing = 28): void {
  const n = pts.length / 3;
  let carried = spacing / 2;
  for (let i = 1; i < n; i += 1) {
    const x0 = pts[(i - 1) * 3];
    const y0 = pts[(i - 1) * 3 + 1];
    const z0 = pts[(i - 1) * 3 + 2];
    const x1 = pts[i * 3];
    const y1 = pts[i * 3 + 1];
    const z1 = pts[i * 3 + 2];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 0.01) continue;
    const heading = Math.atan2(y1 - y0, x1 - x0);
    let s = spacing - carried;
    while (s <= len) {
      const t = s / len;
      const z = z0 + (z1 - z0) * t;
      if (z > PIER_FROM) {
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        if (width > 13) {
          const ox = -Math.sin(heading) * width * 0.27;
          const oy = Math.cos(heading) * width * 0.27;
          box(b, x + ox, y + oy, 0, z - DECK_THICKNESS, 0.9, 0.9, heading, c, c);
          box(b, x - ox, y - oy, 0, z - DECK_THICKNESS, 0.9, 0.9, heading, c, c);
          box(b, x, y, z - DECK_THICKNESS - 1.1, z - DECK_THICKNESS, 0.9, width * 0.42, heading, c, c);
        } else {
          box(b, x, y, 0, z - DECK_THICKNESS, 0.9, Math.min(1.4, Math.max(0.6, width * 0.2)), heading, c, c);
        }
      }
      s += spacing;
    }
    carried = (carried + len) % spacing;
  }
}
