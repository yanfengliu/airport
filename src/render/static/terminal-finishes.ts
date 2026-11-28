import type { TerminalBuilding } from '../../shared/layout.ts';
import { withinAny } from '../../sim/terminal/fittings.ts';
import { box, rgb, shade, type MeshBuilder, type RGB } from '../builder.ts';

/** SFO T1 Concession Guidelines, Gensler's T2 and Tutor Perini's Boarding Area G.
 * The materials follow the published buildings. Colours and panel sizes approximate the finishes. */
const FINISH = {
  milk: { slab: rgb(0xe5dfd3), carpet: rgb(0x687476), wall: rgb(0xcaa678), panel: 'timber' },
  two: { slab: rgb(0xdbdce0), carpet: rgb(0x596b74), wall: rgb(0xc7c9c9), panel: 'metal' },
  international: { slab: rgb(0xbec2c1), carpet: rgb(0x536270), wall: rgb(0xd6ccba), panel: 'limestone' },
  other: { slab: rgb(0xdcd8cf), carpet: rgb(0x4f5e74), wall: rgb(0xe9e5dd), panel: 'plain' },
} as const;

export function finishFor(building: string) {
  if (building === 'Harvey Milk Terminal 1') return FINISH.milk;
  if (building === 'Terminal 2') return FINISH.two;
  if (building.startsWith('International ')) return FINISH.international;
  return FINISH.other;
}

/** Resolve indoor finishes against the mapped building, including its courtyard openings. */
export function buildingFinishes(buildings: readonly TerminalBuilding[]) {
  const zones = buildings.map((b) => ({ finish: finishFor(b.name), contains: withinAny([b.poly]) }))
    .filter((z) => z.finish !== FINISH.other);
  return (x: number, y: number) => zones.find((z) => z.contains(x, y))?.finish ?? FINISH.other;
}

/** Timber panels around the T1 storefronts and limestone courses in the International boarding areas.
 * The cladding replaces the existing wall skin inside its thickness, including at each doorway. */
export function panelledWall(b: MeshBuilder, x0: number, y0: number, x1: number, y1: number, h0: number, h1: number, thickness: number, finish: ReturnType<typeof finishFor>, top: RGB): void {
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (length < 0.05) return;
  const heading = Math.atan2(y1 - y0, x1 - x0);
  const timber = finish.panel === 'timber';
  const courses = timber ? 1 : Math.max(1, Math.round((h1 - h0) / 0.75));
  const panels = Math.max(1, Math.round(length / (timber ? 0.65 : 1.8)));
  const colour = finish.wall;
  box(b, (x0 + x1) / 2, (y0 + y1) / 2, h0, h1, length / 2, thickness / 2 - 0.012, heading, shade(colour, 0.56), top);
  for (let r = 0; r < courses; r += 1) {
    for (let k = 0; k < panels; k += 1) {
      const u = (k + 0.5) / panels;
      const low = h0 + r * (h1 - h0) / courses;
      const high = h0 + (r + 1) * (h1 - h0) / courses;
      const value = 0.9 + ((k * 7 + r * 3) % 5) * (timber ? 0.042 : 0.025);
      box(b, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, low + 0.007, high - 0.007, length / (2 * panels) - 0.008, thickness / 2, heading, shade(colour, value), top);
    }
  }
}
