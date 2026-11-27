// Local planar coordinates for the airport: metres east (x) and north (y) of a fixed origin.
// An equirectangular tangent projection on a sphere of the earth's mean radius: within about 0.2%
// of the true ground distance at SFO's latitude, some metres across the ~6 km the layout spans,
// which keeps the runways within their published lengths' 1%.

export const ORIGIN_LAT = 37.619;
export const ORIGIN_LON = -122.375;

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS_M * DEG;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(ORIGIN_LAT * DEG);

export type Vec2 = [number, number];

export function project(lat: number, lon: number): Vec2 {
  return [(lon - ORIGIN_LON) * M_PER_DEG_LON, (lat - ORIGIN_LAT) * M_PER_DEG_LAT];
}

export function unproject(x: number, y: number): { lat: number; lon: number } {
  return { lat: ORIGIN_LAT + y / M_PER_DEG_LAT, lon: ORIGIN_LON + x / M_PER_DEG_LON };
}

export const round1 = (v: number): number => Math.round(v * 10) / 10;

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);
  return total;
}

/** Signed area of a ring, positive when counter-clockwise (x east, y north). */
export function ringArea(ring: readonly Vec2[]): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return twice / 2;
}

export function ringCentroid(ring: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
    twice += cross;
  }
  if (Math.abs(twice) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of ring) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * twice), cy / (3 * twice)];
}

export function pointInRing(x: number, y: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(x: number, y: number, outer: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): boolean {
  if (!pointInRing(x, y, outer)) return false;
  for (const hole of holes) if (pointInRing(x, y, hole)) return false;
  return true;
}

/** Closest point on segment ab to p, with its parameter t in [0, 1] and distance. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const point: Vec2 = [a[0] + dx * t, a[1] + dy * t];
  return { point, t, distance: dist(p, point) };
}

export function distanceToPolyline(p: Vec2, points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    best = Math.min(best, closestOnSegment(p, points[i - 1], points[i]).distance);
  }
  return points.length === 1 ? dist(p, points[0]) : best;
}

/** Douglas-Peucker simplification that always keeps both endpoints. */
export function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]] as Vec2);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = closestOnSegment(points[i], points[first], points[last]).distance;
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push([points[i][0], points[i][1]]);
  return out;
}

/** Heading in radians, 0 = east, counter-clockwise positive, from a to b. */
export function heading(a: Vec2, b: Vec2): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/** Smallest signed difference a - b, in (-pi, pi]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Compass bearing in degrees (0 = north, clockwise) of a heading given in radians from east. */
export function compassDeg(headingRad: number): number {
  const deg = 90 - (headingRad * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Point and heading at distance s along a polyline. */
export function alongPolyline(points: readonly Vec2[], s: number): { point: Vec2; heading: number } {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = dist(a, b);
    if (remaining <= len || i === points.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, remaining / len);
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: heading(a, b) };
    }
    remaining -= len;
  }
  return { point: [points[0][0], points[0][1]], heading: 0 };
}
