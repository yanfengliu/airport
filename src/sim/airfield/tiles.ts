// The ground cut into small square tiles. A fuselage holds every tile near it, so two aircraft
// that hold no tile in common are apart whatever lines they are on: lines that cross without a
// junction, lines that run close side by side, a tail swinging wide of its line in a turn.

/** Side of a tile, metres. */
export const TILE = 5;
/** Half the width of the strip of ground a fuselage holds, metres. */
export const KEEP = 3.25;
/**
 * A tile belongs to a fuselage when its centre is within this of the fuselage's centreline. Two
 * centrelines closer than twice KEEP always share a tile; two farther apart than twice this never do.
 */
const REACH = KEEP + TILE * Math.SQRT1_2;

export class TileGrid {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  readonly count: number;

  constructor(minX: number, minY: number, maxX: number, maxY: number) {
    const pad = 150;
    this.x0 = Math.floor((minX - pad) / TILE) * TILE;
    this.y0 = Math.floor((minY - pad) / TILE) * TILE;
    this.cols = Math.ceil((maxX + pad - this.x0) / TILE);
    this.rows = Math.ceil((maxY + pad - this.y0) / TILE);
    this.count = this.cols * this.rows;
  }

  /** The centre of a tile. */
  centre(tile: number): { x: number; y: number } {
    return { x: this.x0 + ((tile % this.cols) + 0.5) * TILE, y: this.y0 + (Math.floor(tile / this.cols) + 0.5) * TILE };
  }

  /** Add to `out` every tile a fuselage lying from a to b holds. Points off the grid hold nothing. */
  cover(ax: number, ay: number, bx: number, by: number, out: number[]): void {
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - REACH - this.x0) / TILE));
    const c1 = Math.min(this.cols - 1, Math.floor((Math.max(ax, bx) + REACH - this.x0) / TILE));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - REACH - this.y0) / TILE));
    const r1 = Math.min(this.rows - 1, Math.floor((Math.max(ay, by) + REACH - this.y0) / TILE));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const reach2 = REACH * REACH;
    for (let r = r0; r <= r1; r += 1) {
      const py = this.y0 + (r + 0.5) * TILE;
      for (let c = c0; c <= c1; c += 1) {
        const px = this.x0 + (c + 0.5) * TILE;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const ex = px - (ax + dx * t);
        const ey = py - (ay + dy * t);
        if (ex * ex + ey * ey <= reach2) out.push(r * this.cols + c);
      }
    }
  }
}
