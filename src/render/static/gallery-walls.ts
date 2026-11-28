import type { PolygonData } from '../../shared/layout.ts';
import { insidePolygon } from '../../sim/terminal/fittings.ts';

// The separately mapped gallery tips and terminal outlines stop up to half a metre apart.
const JOIN_METRES = 0.6;

export type Wall = [number, number, number, number];

/** Visible wall spans. Where the public gallery and a terminal overlap, the intersection of
 * their mapped footprints cuts the opening, even if it occupies only part of a long edge. */
export function exteriorWallRuns(ring: readonly number[], floorAt: (x: number, y: number) => boolean, adjoining: readonly PolygonData[] = []): Wall[] {
  const walls: Wall[] = [];
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const x = ring[i], y = ring[i + 1], dx = ring[j] - x, dy = ring[j + 1] - y;
    const length = Math.hypot(dx, dy);
    if (length < 0.05) continue;
    const ux = dy / length, uy = -dx / length;
    const offsets = [-JOIN_METRES, 0, JOIN_METRES];
    const cuts = [0, 1];
    for (const poly of adjoining) {
      for (const boundary of [poly.outer, ...(poly.holes ?? [])]) {
        for (let k = 0, l = boundary.length - 2; k < boundary.length; l = k, k += 2) {
          const ex = boundary[k] - boundary[l], ey = boundary[k + 1] - boundary[l + 1];
          const cross = dx * ey - dy * ex;
          if (Math.abs(cross) < 1e-8) continue;
          for (const offset of offsets) {
            const ax = boundary[l] - x - ux * offset, ay = boundary[l + 1] - y - uy * offset;
            const t = (ax * ey - ay * ex) / cross, u = (ax * dy - ay * dx) / cross;
            if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
          }
        }
      }
    }
    cuts.sort((a, b) => a - b);
    const nx = ux * 2.6, ny = uy * 2.6;
    for (let c = 1; c < cuts.length; c++) {
      const from = cuts[c - 1], to = cuts[c];
      if ((to - from) * length < 0.05) continue;
      const mid = (from + to) / 2, mx = x + dx * mid, my = y + dy * mid;
      if (adjoining.some((p) => offsets.some((d) => insidePolygon(p, mx + ux * d, my + uy * d)))) continue;
      if (floorAt(mx + nx, my + ny) && floorAt(mx - nx, my - ny)) continue;
      walls.push([x + dx * from, y + dy * from, x + dx * to, y + dy * to]);
    }
  }
  return walls;
}

export function terminalGlazing(buildings: readonly PolygonData[], gallery: PolygonData | undefined, floorAt: (x: number, y: number) => boolean): Wall[] {
  const walls = gallery ? exteriorWallRuns(gallery.outer, floorAt, buildings) : [];
  const adjoining = gallery ? [gallery] : [];
  for (const b of buildings) {
    for (const ring of [b.outer, ...(b.holes ?? [])]) walls.push(...exteriorWallRuns(ring, floorAt, adjoining));
  }
  return walls;
}
