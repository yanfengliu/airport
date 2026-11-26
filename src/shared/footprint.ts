// How much room a parked aircraft takes, for deciding which stands can be used side by side.
// An aircraft is drawn as three lines on the ground: the fuselage and the two swept wings.

export interface Parked {
  /** Where the nose wheel stops, and the direction the aircraft faces, radians from east. */
  x: number;
  y: number;
  heading: number;
  span: number;
  length: number;
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

/** Can the two stand side by side? */
export function fitTogether(a: Parked, b: Parked): boolean {
  return parkedClearance(a, b) >= STAND_CLEARANCE;
}
