// A walkable floor as a grid: which cells are inside the buildings, and for any set of goal
// cells, how far every other cell is from the nearest goal by foot. People walk downhill on one
// of these distance fields, so thousands can share a route without anyone searching for it.

import type { PolygonData } from '../../shared/layout.ts';

/** Cost of a step to a side neighbour and to a diagonal one. */
const STRAIGHT = 10;
const DIAGONAL = 14;
/** Extra cost of walking in a cell that touches a wall, so routes keep to the middle of a hall. */
const WALL_COST = 7;
export const UNREACHABLE = 65535;

/** Offsets of the eight neighbours: the four sides first, then the corners. */
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];

export class NavGrid {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  /** Walkable cell id at each grid position, or -1. */
  readonly index: Int32Array;
  readonly count: number;
  /** Centre of each walkable cell. */
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  /** The eight neighbours of each walkable cell (ids, or -1), in DX/DY order. */
  readonly neighbours: Int32Array;
  /** 1 where a cell touches the edge of the floor. */
  readonly edge: Uint8Array;
  /** People standing in each cell right now. */
  readonly occupancy: Uint16Array;
  /**
   * Extra cost of stepping into each cell: furniture stands there (seats, counters, shelves), so
   * walkers go round it where they can. It never cuts a way off, only makes it dearer.
   */
  readonly extra: Uint8Array;

  /** `keep`, when given, leaves out cells whose centre it rejects, to cut one floor into parts. */
  constructor(polygons: readonly PolygonData[], cell: number, keep?: (x: number, y: number) => boolean) {
    this.cell = cell;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of polygons) {
      for (let i = 0; i < p.outer.length; i += 2) {
        minX = Math.min(minX, p.outer[i]);
        maxX = Math.max(maxX, p.outer[i]);
        minY = Math.min(minY, p.outer[i + 1]);
        maxY = Math.max(maxY, p.outer[i + 1]);
      }
    }
    this.x0 = Math.floor(minX / cell) * cell - cell;
    this.y0 = Math.floor(minY / cell) * cell - cell;
    this.cols = Math.ceil((maxX - this.x0) / cell) + 2;
    this.rows = Math.ceil((maxY - this.y0) / cell) + 2;
    const inside = new Uint8Array(this.cols * this.rows);

    // Scanline fill of every polygon: a cell is floor when its centre is inside any of them.
    for (const p of polygons) {
      const rings = [p.outer, ...(p.holes ?? [])];
      for (let row = 0; row < this.rows; row += 1) {
        const y = this.y0 + (row + 0.5) * cell;
        const crossings: number[] = [];
        for (const ring of rings) {
          for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const yi = ring[i + 1];
            const yj = ring[j + 1];
            if (yi > y !== yj > y) crossings.push(ring[i] + ((y - yi) / (yj - yi)) * (ring[j] - ring[i]));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let k = 0; k + 1 < crossings.length; k += 2) {
          const from = Math.max(0, Math.ceil((crossings[k] - this.x0) / cell - 0.5));
          const to = Math.min(this.cols - 1, Math.floor((crossings[k + 1] - this.x0) / cell - 0.5));
          for (let col = from; col <= to; col += 1) {
            if (keep && !keep(this.x0 + (col + 0.5) * cell, y)) continue;
            inside[row * this.cols + col] = 1;
          }
        }
      }
    }

    this.index = new Int32Array(this.cols * this.rows).fill(-1);
    let count = 0;
    for (let i = 0; i < inside.length; i += 1) if (inside[i]) this.index[i] = count++;
    this.count = count;
    this.cx = new Float32Array(count);
    this.cy = new Float32Array(count);
    this.neighbours = new Int32Array(count * 8).fill(-1);
    this.edge = new Uint8Array(count);
    this.occupancy = new Uint16Array(count);
    this.extra = new Uint8Array(count);
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const id = this.index[row * this.cols + col];
        if (id < 0) continue;
        this.cx[id] = this.x0 + (col + 0.5) * cell;
        this.cy[id] = this.y0 + (row + 0.5) * cell;
        const at = (dc: number, dr: number): number => {
          const c = col + dc;
          const r = row + dr;
          return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : this.index[r * this.cols + c];
        };
        for (let k = 0; k < 8; k += 1) {
          let n = at(DX[k], DY[k]);
          // No cutting a corner: a diagonal step needs both cells beside it.
          if (k >= 4 && (at(DX[k], 0) < 0 || at(0, DY[k]) < 0)) n = -1;
          this.neighbours[id * 8 + k] = n;
          if (k < 4 && n < 0) this.edge[id] = 1;
        }
      }
    }
  }

  /** Walkable cell containing a point, or -1. */
  cellAt(x: number, y: number): number {
    const col = Math.floor((x - this.x0) / this.cell);
    const row = Math.floor((y - this.y0) / this.cell);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return this.index[row * this.cols + col];
  }

  /** The walkable cell nearest a point, searching outwards up to `reach` metres. */
  nearestCell(x: number, y: number, reach = 40): number {
    const direct = this.cellAt(x, y);
    if (direct >= 0) return direct;
    const col = Math.floor((x - this.x0) / this.cell);
    const row = Math.floor((y - this.y0) / this.cell);
    const rings = Math.ceil(reach / this.cell);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 1; ring <= rings && best < 0; ring += 1) {
      for (let dr = -ring; dr <= ring; dr += 1) {
        for (let dc = -ring; dc <= ring; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const c = col + dc;
          const r = row + dr;
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
          const id = this.index[r * this.cols + c];
          if (id < 0) continue;
          const d = Math.hypot(this.cx[id] - x, this.cy[id] - y);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  /**
   * Walking distance from every cell to the nearest of `goals`, in tenths of a cell. Cells that
   * cannot reach any goal hold UNREACHABLE.
   */
  field(goals: readonly number[]): Uint16Array {
    const distance = new Uint16Array(this.count).fill(UNREACHABLE);
    // Bucket queue: costs are small integers, so cells are kept in lists by cost.
    const buckets: number[][] = [];
    const push = (cost: number, id: number): void => {
      (buckets[cost] ??= []).push(id);
    };
    for (const g of goals) {
      if (g < 0 || g >= this.count) continue;
      distance[g] = 0;
      push(0, g);
    }
    for (let cost = 0; cost < buckets.length; cost += 1) {
      const bucket = buckets[cost];
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        const id = bucket[i];
        if (distance[id] !== cost) continue;
        for (let k = 0; k < 8; k += 1) {
          const n = this.neighbours[id * 8 + k];
          if (n < 0) continue;
          const next = cost + (k < 4 ? STRAIGHT : DIAGONAL) + (this.edge[n] ? WALL_COST : 0) + this.extra[n];
          if (next < distance[n] && next < UNREACHABLE) {
            distance[n] = next;
            push(next, n);
          }
        }
      }
      buckets[cost] = undefined as unknown as number[];
    }
    return distance;
  }

  /**
   * The neighbour to step to from `cell` to get nearer the goal of `field`. `choice` in [0, 1)
   * picks among neighbours that are nearly as good, so a crowd spreads across a hall.
   */
  downhill(field: Uint16Array, cell: number, choice: number): number {
    const here = field[cell];
    if (here === 0 || here === UNREACHABLE) return cell;
    let best = cell;
    let bestCost = here;
    let second = -1;
    let secondCost = UNREACHABLE;
    for (let k = 0; k < 8; k += 1) {
      const n = this.neighbours[cell * 8 + k];
      if (n < 0) continue;
      const cost = field[n];
      if (cost < bestCost) {
        second = best === cell ? -1 : best;
        secondCost = bestCost;
        best = n;
        bestCost = cost;
      } else if (cost < secondCost && cost < here) {
        second = n;
        secondCost = cost;
      }
    }
    if (second >= 0 && secondCost - bestCost <= 4 && choice < 0.4) return second;
    return best;
  }
}
