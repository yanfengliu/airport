// How much room a parked aircraft takes, for deciding which stands can be used side by side.
// An aircraft is drawn as three lines on the ground: the fuselage and the two swept wings.

export interface Parked {
  /** Where the nose wheel stops, and the direction the aircraft faces, radians from east. */
  x: number;
  y: number;
  heading: number;
  span: number;
  length: number;
  /** Width of the fuselage, metres, when known. */
  fuselage?: number;
}

/** Room kept between two aircraft on neighbouring stands, wingtip to wingtip, metres. */
export const STAND_CLEARANCE = 3;
/** The smallest airliner a stand is ever asked to take: a regional jet. */
export const SMALLEST = { span: 29, length: 32 } as const;

/** A typical fuselage length for a wingspan, for when only the span is known. */
export function lengthForSpan(span: number): number {
  if (span <= 30) return 32;
  if (span <= 37) return 42;
  if (span <= 53) return 55;
  return Math.min(76, 1.08 * span);
}

type Segment = [number, number, number, number];

function segments(p: Parked): Segment[] {
  const ux = Math.cos(p.heading);
  const uy = Math.sin(p.heading);
  const nx = -uy;
  const ny = ux;
  // The nose is a few metres ahead of the nose wheel; the wing root sits just ahead of mid-length
  // and the tips trail it.
  const noseX = p.x + ux * 4;
  const noseY = p.y + uy * 4;
  const tailX = noseX - ux * p.length;
  const tailY = noseY - uy * p.length;
  const rootX = noseX - ux * p.length * 0.42;
  const rootY = noseY - uy * p.length * 0.42;
  const tipBack = p.length * 0.14;
  const half = p.span / 2;
  return [
    [noseX, noseY, tailX, tailY],
    [rootX, rootY, rootX - ux * tipBack + nx * half, rootY - uy * tipBack + ny * half],
    [rootX, rootY, rootX - ux * tipBack - nx * half, rootY - uy * tipBack - ny * half],
  ];
}

function pointToSegment(px: number, py: number, s: Segment): number {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / len2));
  return Math.hypot(px - (s[0] + dx * t), py - (s[1] + dy * t));
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function segmentDistance(a: Segment, b: Segment): number {
  const d1 = cross(a[2] - a[0], a[3] - a[1], b[0] - a[0], b[1] - a[1]);
  const d2 = cross(a[2] - a[0], a[3] - a[1], b[2] - a[0], b[3] - a[1]);
  const d3 = cross(b[2] - b[0], b[3] - b[1], a[0] - b[0], a[1] - b[1]);
  const d4 = cross(b[2] - b[0], b[3] - b[1], a[2] - b[0], a[3] - b[1]);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(pointToSegment(a[0], a[1], b), pointToSegment(a[2], a[3], b), pointToSegment(b[0], b[1], a), pointToSegment(b[2], b[3], a));
}

/** The smallest gap between two parked aircraft, metres; 0 when they overlap. */
export function parkedClearance(a: Parked, b: Parked): number {
  // Far apart: no need to look closer.
  const reach = (a.length + b.length + a.span + b.span) / 2 + 20;
  if (Math.hypot(a.x - b.x, a.y - b.y) > reach) return Infinity;
  let least = Infinity;
  for (const sa of segments(a)) for (const sb of segments(b)) least = Math.min(least, segmentDistance(sa, sb));
  return least;
}

/** The smallest gap between the centrelines of two aircraft's fuselages, metres. */
export function bodyClearance(a: Parked, b: Parked): number {
  if (Math.hypot(a.x - b.x, a.y - b.y) > a.length + b.length + 20) return Infinity;
  return segmentDistance(segments(a)[0], segments(b)[0]);
}

/** Can the two stand side by side? */
export function fitTogether(a: Parked, b: Parked): boolean {
  return parkedClearance(a, b) >= STAND_CLEARANCE;
}

/**
 * An aircraft seen from above, as the model draws one: the fuselage as wide as it is, the two
 * swept wings with their chord, broad at the root and narrow at the tip, and the tailplane. Each
 * is a polygon of x, y pairs.
 */
export function outline(p: Parked): number[][] {
  const ux = Math.cos(p.heading);
  const uy = Math.sin(p.heading);
  const nx = -uy;
  const ny = ux;
  const width = p.fuselage ?? Math.max(3.3, 0.09 * p.length);
  const noseX = p.x + ux * 4;
  const noseY = p.y + uy * 4;
  /** A point `back` metres behind the nose and `side` metres to the left of the centreline. */
  const at = (back: number, side: number): [number, number] => [noseX - ux * back + nx * side, noseY - uy * back + ny * side];
  const L = p.length;
  const semi = p.span / 2;
  const root = width * 0.3;
  const rootChord = p.span * 0.19;
  const tipChord = rootChord * 0.22;
  const rootLead = L * 0.36;
  const tipLead = rootLead + Math.tan(0.5) * (semi - root);
  const tailSemi = p.span * 0.18;
  const tailChord = L * 0.1;
  const tailLead = L * 0.84;
  const polygons: number[][] = [[...at(0, width / 2), ...at(L, width / 2), ...at(L, -width / 2), ...at(0, -width / 2)]];
  for (const side of [1, -1]) {
    polygons.push([...at(rootLead, side * root), ...at(tipLead, side * semi), ...at(tipLead + tipChord, side * semi), ...at(rootLead + rootChord, side * root)]);
    polygons.push([...at(tailLead, 0), ...at(tailLead + tailSemi * 0.6, side * tailSemi), ...at(tailLead + tailSemi * 0.6 + tailChord * 0.4, side * tailSemi), ...at(Math.min(L, tailLead + tailChord), 0)]);
  }
  return polygons;
}

function insidePolygon(x: number, y: number, poly: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    if (poly[i + 1] > y !== poly[j + 1] > y && x < ((poly[j] - poly[i]) * (y - poly[i + 1])) / (poly[j + 1] - poly[i + 1]) + poly[i]) inside = !inside;
  }
  return inside;
}

/** The gap between two polygons, metres; 0 when they overlap. */
function polygonGap(a: readonly number[], b: readonly number[]): number {
  if (insidePolygon(a[0], a[1], b) || insidePolygon(b[0], b[1], a)) return 0;
  let least = Infinity;
  for (let i = 0; i < a.length; i += 2) {
    const ea: Segment = [a[i], a[i + 1], a[(i + 2) % a.length], a[(i + 3) % a.length]];
    for (let j = 0; j < b.length; j += 2) {
      const eb: Segment = [b[j], b[j + 1], b[(j + 2) % b.length], b[(j + 3) % b.length]];
      least = Math.min(least, segmentDistance(ea, eb));
      if (least === 0) return 0;
    }
  }
  return least;
}

/** An aircraft's outline made ready for many comparisons: its polygons, each with its bounding box. */
export interface Shape {
  x: number;
  y: number;
  /** How far from (x, y) any part of it reaches. */
  reach: number;
  polygons: number[][];
  /** Per polygon: least x, least y, greatest x, greatest y. */
  boxes: [number, number, number, number][];
}

export function shapeOf(p: Parked): Shape {
  const polygons = outline(p);
  const boxes = polygons.map((poly): [number, number, number, number] => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]);
      y0 = Math.min(y0, poly[i + 1]);
      x1 = Math.max(x1, poly[i]);
      y1 = Math.max(y1, poly[i + 1]);
    }
    return [x0, y0, x1, y1];
  });
  return { x: p.x, y: p.y, reach: (p.length + p.span) / 2 + 8, polygons, boxes };
}

/**
 * The smallest gap between two aircraft drawn as they are, wings and fuselage at their width; 0
 * when they touch. Only gaps under `limit` are worked out exactly: parts further apart than that
 * are passed over, and the answer is then `limit` or more.
 */
export function shapeClearance(a: Shape, b: Shape, limit = Infinity): number {
  if (Math.hypot(a.x - b.x, a.y - b.y) > a.reach + b.reach + limit) return Infinity;
  let least = Infinity;
  for (let i = 0; i < a.polygons.length; i += 1) {
    const ba = a.boxes[i];
    for (let j = 0; j < b.polygons.length; j += 1) {
      const bb = b.boxes[j];
      const apart = Math.hypot(Math.max(0, ba[0] - bb[2], bb[0] - ba[2]), Math.max(0, ba[1] - bb[3], bb[1] - ba[3]));
      if (apart >= Math.min(limit, least)) continue;
      least = Math.min(least, polygonGap(a.polygons[i], b.polygons[j]));
      if (least === 0) return 0;
    }
  }
  return least;
}

/** The smallest gap between two aircraft drawn as they are; see shapeClearance. */
export function outlineClearance(a: Parked, b: Parked, limit = Infinity): number {
  return shapeClearance(shapeOf(a), shapeOf(b), limit);
}

/** The smallest gap between two fuselages, side to side at their width; 0 when they touch. */
export function fuselageClearance(a: Parked | Shape, b: Parked | Shape): number {
  const sa = 'polygons' in a ? a : shapeOf(a);
  const sb = 'polygons' in b ? b : shapeOf(b);
  if (Math.hypot(sa.x - sb.x, sa.y - sb.y) > sa.reach + sb.reach) return Infinity;
  return polygonGap(sa.polygons[0], sb.polygons[0]);
}
