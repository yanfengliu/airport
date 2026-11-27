// The parts of each piece of ground equipment, in numbers: blocks and sloping slabs. The model
// (gse.ts) is built from them, and the equipment placed round a parked aircraft
// (src/render/dynamic/gse-places.ts) is kept apart by them. No three.js here, so that the
// placement can be checked without a GPU.
//
// Body frame: x forward, y left, z up, origin on the ground under the middle.

export type GseKind = 'tug' | 'pushback' | 'loader' | 'carts' | 'fuel' | 'catering' | 'power' | 'stairs';
export type GseColour = 'tyre' | 'white' | 'yellow' | 'orange' | 'blue' | 'grey' | 'dark' | 'belt' | 'silver';

/** A block centred over (x, y), from height h0 up to h1, `halfLength` along x and `halfWidth` along y, with the colour of its sides and of its top. */
export interface GseBlock {
  kind: 'block';
  x: number;
  y: number;
  h0: number;
  h1: number;
  halfLength: number;
  halfWidth: number;
  side: GseColour;
  top: GseColour;
}

/** A sloping slab, for conveyor belts and stairs: its top from (x0, z0) up to (x1, z1), `halfWidth` either side of y = 0, `thick` deep. */
export interface GseSlope {
  kind: 'slope';
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  halfWidth: number;
  thick: number;
  colour: GseColour;
}

export type GsePart = GseBlock | GseSlope;

const block = (x: number, y: number, h0: number, h1: number, halfLength: number, halfWidth: number, side: GseColour, top: GseColour): GseBlock => ({ kind: 'block', x, y, h0, h1, halfLength, halfWidth, side, top });
const slope = (x0: number, z0: number, x1: number, z1: number, halfWidth: number, thick: number, colour: GseColour): GseSlope => ({ kind: 'slope', x0, z0, x1, z1, halfWidth, thick, colour });

/** A pair of wheels on each axle at `xs`, their outer faces `halfWidth` out. */
function wheels(xs: number[], halfWidth: number, radius: number): GseBlock[] {
  const out: GseBlock[] = [];
  for (const x of xs) for (const side of [1, -1]) out.push(block(x, side * (halfWidth - 0.1), 0, radius * 2, radius, 0.13, 'tyre', 'tyre'));
  return out;
}

export function gseParts(kind: GseKind): GsePart[] {
  switch (kind) {
    case 'tug':
      return [block(0, 0, 0.3, 1.05, 1.5, 0.75, 'white', 'white'), block(-0.5, 0, 1.05, 1.8, 0.55, 0.7, 'dark', 'white'), ...wheels([0.9, -0.9], 0.75, 0.3)];
    case 'pushback':
      return [
        block(0, 0, 0.35, 1.25, 3.4, 1.35, 'yellow', 'yellow'),
        block(1.6, 0, 1.25, 2.05, 0.9, 1.1, 'dark', 'yellow'),
        // The tow bar that reaches to the nose gear.
        block(-4.6, 0, 0.35, 0.55, 1.4, 0.12, 'grey', 'grey'),
        ...wheels([2.1, -2.1], 1.35, 0.55),
      ];
    case 'loader':
      return [block(-0.6, 0, 0.35, 1, 2.6, 0.95, 'blue', 'blue'), slope(-3.6, 0.9, 4.2, 2.9, 0.5, 0.25, 'belt'), ...wheels([1.1, -2.2], 0.95, 0.32)];
    case 'carts':
      return [3.6, 0, -3.6].flatMap((x) => [block(x, 0, 0.45, 0.62, 1.55, 0.85, 'grey', 'grey'), block(x, 0, 0.62, 1.7, 1.45, 0.78, 'silver', 'silver'), ...wheels([x + 1, x - 1], 0.85, 0.22)]);
    case 'fuel':
      return [
        block(3.1, 0, 0.5, 2.5, 1.1, 1.2, 'white', 'white'),
        block(3.75, 0, 1.5, 2.3, 0.5, 1.22, 'dark', 'white'),
        block(-1.2, 0, 0.9, 2.9, 3.1, 1.2, 'silver', 'silver'),
        block(-1.2, 0, 2.9, 3.05, 2.9, 0.4, 'orange', 'orange'),
        ...wheels([3.2, -1.4, -3], 1.2, 0.5),
      ];
    case 'catering':
      return [
        block(3, 0, 0.5, 2.4, 1.1, 1.2, 'white', 'white'),
        block(3.65, 0, 1.4, 2.2, 0.5, 1.22, 'dark', 'white'),
        // The box body, raised on its scissor lift to door height.
        block(-1, 0, 3.4, 5.9, 3, 1.25, 'silver', 'white'),
        block(-1, 0, 0.9, 3.4, 0.25, 0.9, 'grey', 'grey'),
        block(-1, 0, 0.6, 0.9, 3, 1.2, 'grey', 'grey'),
        ...wheels([3.1, -1.6, -2.8], 1.2, 0.45),
      ];
    case 'power':
      return [block(0, 0, 0.3, 1.5, 1.4, 0.8, 'orange', 'orange'), ...wheels([0.8, -0.8], 0.8, 0.25)];
    case 'stairs':
      return [block(-2.6, 0, 0.35, 1.3, 2, 1, 'white', 'white'), slope(-4.2, 0.4, 2.8, 4.1, 0.75, 0.3, 'grey'), block(3.2, 0, 3.9, 4.2, 0.7, 0.9, 'grey', 'grey'), ...wheels([-1.2, -3.8], 1, 0.3)];
    default:
      return [];
  }
}

/** The room a part takes: least and greatest x, y and z. */
export function partExtent(p: GsePart): { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } {
  if (p.kind === 'block') return { x0: p.x - p.halfLength, x1: p.x + p.halfLength, y0: p.y - p.halfWidth, y1: p.y + p.halfWidth, z0: p.h0, z1: p.h1 };
  return { x0: Math.min(p.x0, p.x1), x1: Math.max(p.x0, p.x1), y0: -p.halfWidth, y1: p.halfWidth, z0: Math.min(p.z0, p.z1) - p.thick, z1: Math.max(p.z0, p.z1) };
}
