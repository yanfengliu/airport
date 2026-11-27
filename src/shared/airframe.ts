// The shape of each type of aircraft as it is drawn, in numbers: the fuselage, where the wing
// meets it, the wing's sweep, chords and span, the tip devices, the tail, the engines and the main
// wheels. The aircraft layer, the outline the stands are judged by (footprint.ts) and the ground
// equipment placed round a parked aircraft all read it, so that what is judged is what is drawn.
//
// Most types are drawn with one of Polyfork's airliners fitted to their published length, span and
// height (MODEL_SHAPES, DRAWN_BY): their shapes are that model's, measured by
// tools/models/airliner-shape.ts and scaled the same way, and test/outline.test.ts checks that the
// model as drawn lies inside them. A type with no such model (the A380) is drawn and described by
// the proportions below.
//
// Body frame: x forward, y to the left wing, z up, origin on the ground under the middle of the
// fuselage.

/** What the shape needs of a type of aircraft: its designator, body class and published sizes, metres. */
export interface AirframeType {
  id: string;
  body: string;
  span: number;
  length: number;
  height: number;
  fuselage: number;
}

/** How a type's parts are proportioned to its published sizes. */
interface Proportions {
  /** Where the wing's leading edge meets the fuselage, as a fraction of length behind the nose. */
  wingAt: number;
  /** Leading-edge sweep, radians; root chord as a fraction of span; tip chord as a fraction of root. */
  sweep: number;
  rootChord: number;
  taper: number;
  /** Engine nacelle radius and length, metres; where along the half-span each engine hangs. */
  engineRadius: number;
  engineLength: number;
  engineAt: number[];
  /** Height of the wing-tip device, metres; 0 for a raked tip. */
  winglet: number;
  /** Fuselage height over width, for a double deck. */
  tall: number;
}

const NARROW: Proportions = { wingAt: 0.37, sweep: 0.47, rootChord: 0.185, taper: 0.24, engineRadius: 1.15, engineLength: 4.4, engineAt: [0.33], winglet: 2.4, tall: 1 };
const WIDE: Proportions = { wingAt: 0.34, sweep: 0.58, rootChord: 0.2, taper: 0.16, engineRadius: 1.75, engineLength: 6.6, engineAt: [0.32], winglet: 0, tall: 1 };

const PROPORTIONS: Record<string, Proportions> = {
  E75L: { ...NARROW, wingAt: 0.39, engineRadius: 0.88, engineLength: 3.4, winglet: 1.9, rootChord: 0.17 },
  BCS3: { ...NARROW, engineRadius: 1.08, engineLength: 4, winglet: 2 },
  A320: NARROW,
  A21N: { ...NARROW, wingAt: 0.39, engineRadius: 1.2, engineLength: 4.7 },
  B738: { ...NARROW, wingAt: 0.38, engineRadius: 1.05, winglet: 2.5 },
  B39M: { ...NARROW, wingAt: 0.39, engineRadius: 1.15, winglet: 2.6 },
  B752: { ...NARROW, wingAt: 0.4, engineRadius: 1.25, engineLength: 4.8, winglet: 2.2, sweep: 0.46 },
  B789: { ...WIDE, engineRadius: 1.72, winglet: 0, sweep: 0.6 },
  A359: { ...WIDE, engineRadius: 1.8, winglet: 2.2 },
  B77W: { ...WIDE, wingAt: 0.36, engineRadius: 1.95, engineLength: 7.3 },
  A388: { ...WIDE, wingAt: 0.33, rootChord: 0.21, engineRadius: 1.6, engineLength: 6, engineAt: [0.3, 0.56], winglet: 2.2, tall: 1.19, sweep: 0.6 },
};

/**
 * One of Polyfork's airliners, measured: its size, where its nose is, the fuselage's half width,
 * the underside and top of its cabin and its outline from above (x, half width), the wing and
 * tailplane as tapered surfaces bounding all of each (flaps, ailerons and tip devices included),
 * the fin, the left engine and the left main gear. In the model's own frame and size: x along
 * the aircraft (nose forward), y to its left, z up. Printed by tools/models/airliner-shape.ts.
 */
interface ModelShape {
  length: number;
  span: number;
  height: number;
  nose: number;
  half: number;
  cabin: [number, number];
  body: [number, number][];
  wing: { root: V3; rootChord: number; rootThick: number; tip: V3; tipChord: number; tipThick: number };
  stabiliser: { root: V3; rootChord: number; rootThick: number; tip: V3; tipChord: number; tipThick: number };
  fin: { front: number; back: number; half: number; top: number };
  engines: { y: number; z: number; radius: number; front: number; back: number }[];
  gear: { noseX: number; mainX: number; track: number; halfLength: number; halfWidth: number };
  /** The front and rearmost left doors: the middle of each along the aircraft, and its sill's height. */
  doors: { front: { x: number; sill: number }; rear: { x: number; sill: number } };
}

export const MODEL_SHAPES: Record<string, ModelShape> = {
  'narrow-body-airliner-619183': {
    length: 38.01, span: 35.78, height: 11.95, nose: 18.82, half: 1.98, cabin: [1.35, 6.05],
    body: [[-19.19, 0.47], [-16.69, 2.02], [2.31, 2.02], [12.81, 2.01], [13.31, 2], [14.81, 1.97], [15.31, 1.92], [15.81, 1.86], [16.31, 1.78], [16.81, 1.63], [17.31, 1.45], [17.81, 1.22], [18.31, 0.98], [18.82, 0.66]],
    wing: { root: [5.35, 1, 2.325], rootChord: 7.65, rootThick: 1.29, tip: [-2.96, 17.89, 4.935], tipChord: 2.56, tipThick: 2.47 },
    stabiliser: { root: [-13.49, 0.89, 4.55], rootChord: 3.81, rootThick: 0.42, tip: [-16.79, 6.2, 5.11], tipChord: 1.42, tipThick: 0.16 },
    fin: { front: -9.39, back: -17.3, half: 0.29, top: 11.95 },
    engines: [{ y: 5.8, z: 1.62, radius: 1.05, front: 6.31, back: -0.45 }],
    gear: { noseX: 12.6, mainX: 0.32, track: 3.8, halfLength: 0.89, halfWidth: 0.6 },
    doors: { front: { x: 11.98, sill: 3.23 }, rear: { x: -10.77, sill: 3.23 } },
  },
  'widebody-airliner-ae0a5a': {
    length: 64, span: 60, height: 18, nose: 32, half: 2.99, cabin: [2.07, 8.94],
    body: [[-32, 0.55], [-27, 3.02], [-8.5, 3.03], [11, 3.03], [25.5, 3.01], [26.5, 2.91], [27.5, 2.81], [28, 2.66], [29, 2.3], [29.5, 2.1], [31, 1.39], [32, 0.82]],
    wing: { root: [10.82, 2.98, 3.755], rootChord: 18.97, rootThick: 1.89, tip: [-9.03, 30, 6.245], tipChord: 1.78, tipThick: 0.65 },
    stabiliser: { root: [-21.29, 1, 6.385], rootChord: 7.31, rootThick: 0.63, tip: [-27.6, 10.81, 7.56], tipChord: 2.01, tipThick: 0.18 },
    fin: { front: -19.6, back: -31.78, half: 0.43, top: 18 },
    engines: [{ y: 9.8, z: 2.65, radius: 1.84, front: 9.95, back: -0.61 }],
    gear: { noseX: 26.37, mainX: 0, track: 5.73, halfLength: 2, halfWidth: 0.44 },
    doors: { front: { x: 24.05, sill: 4.82 }, rear: { x: -18.5, sill: 4.82 } },
  },
};

/** Which of Polyfork's airliners draws each type; the rest are drawn from their proportions. */
export const DRAWN_BY: Record<string, string> = {
  E75L: 'narrow-body-airliner-619183',
  BCS3: 'narrow-body-airliner-619183',
  A320: 'narrow-body-airliner-619183',
  A21N: 'narrow-body-airliner-619183',
  B738: 'narrow-body-airliner-619183',
  B39M: 'narrow-body-airliner-619183',
  B752: 'narrow-body-airliner-619183',
  B789: 'widebody-airliner-ae0a5a',
  A359: 'widebody-airliner-ae0a5a',
  B77W: 'widebody-airliner-ae0a5a',
};

/**
 * Types Polyfork has no model of, drawn with one of our own built from their proportions here
 * (tools/models/original/airliner.ts): at their own size, centred on the aircraft's point.
 */
export const OWN_MODEL: Record<string, string> = {
  A388: 'double-deck-airliner',
};

/**
 * How a type's model is fitted to it: the model's id, and the scales along its length, across its
 * span and up its height that bring it to the type's published size, with `mid` the model's x at
 * the middle of its length (the aircraft's point). Null for a type drawn from its proportions.
 */
export function modelFit(type: AirframeType): { id: string; along: number; across: number; up: number; mid: number } | null {
  const id = DRAWN_BY[type.id];
  const shape = id ? MODEL_SHAPES[id] : undefined;
  if (!id || !shape) return null;
  return { id, along: type.length / shape.length, across: type.span / shape.span, up: type.height / shape.height, mid: shape.nose - shape.length / 2 };
}

export type V3 = [number, number, number];

/**
 * A lifting surface: a tapered slab from a root section to a tip section, each given by its
 * leading-edge point, its chord (running back along -x) and its thickness. An upright one (the
 * fin, a winglet) is thick across y instead of z.
 */
export interface Surface {
  root: V3;
  rootChord: number;
  rootThick: number;
  tip: V3;
  tipChord: number;
  tipThick: number;
  upright: boolean;
}

/** An engine's nacelle: stations from its back to its front (x, centre height, half width, half height), hanging at `y` from the wing's leading edge at (`leX`, `leZ`). */
export interface Engine {
  y: number;
  stations: [number, number, number, number][];
  front: number;
  radius: number;
  z: number;
  leX: number;
  leZ: number;
  length: number;
}

/** One side of the aircraft, `side` 1 for the left and -1 for the right. */
export interface Side {
  side: 1 | -1;
  wing: Surface;
  winglet: Surface | null;
  engines: Engine[];
  stabiliser: Surface;
}

export interface Airframe {
  type: AirframeType;
  /** Half the length; the fuselage's half width and half height, and the height of its centre line. */
  half: number;
  ry: number;
  rz: number;
  zc: number;
  /** Fuselage height over width. */
  tall: number;
  noseLength: number;
  tailLength: number;
  noseStart: number;
  /** The fuselage as stations from the tail cone to the nose: x, centre height, half width, half height. */
  stations: [number, number, number, number][];
  /** The band of cabin windows each side: from and to along x, its height, and how far out it stands. */
  windows: { from: number; to: number; z: number; y: number };
  /** The middle of the flight deck glazing, along x. */
  deckX: number;
  /** The wing: half-span, where its root meets the fuselage (out from the centreline), chords, and its leading edge at the root and at the tip. */
  semi: number;
  wingRoot: number;
  rootChord: number;
  tipChord: number;
  wingX: number;
  wingZ: number;
  tipX: number;
  tipZ: number;
  sides: [Side, Side];
  fin: Surface;
  /** The front and rearmost passenger doors on the left: where each is along x, and its sill's height. */
  doors: { front: { x: number; sill: number }; rear: { x: number; sill: number } };
  /** The landing gear: wheel radius, where the nose gear and main gear stand along x, the main gear's distance out from the centreline, and the offsets of its bogie's axles. */
  wheelR: number;
  noseGearX: number;
  mainGearX: number;
  track: number;
  bogies: number[];
}

const airframes = new WeakMap<AirframeType, Airframe>();

/** The drawn shape of a type of aircraft, worked out once per type. */
export function airframe(type: AirframeType): Airframe {
  const known = airframes.get(type);
  if (known) return known;
  const fit = modelFit(type);
  if (fit) {
    const fitted = fittedAirframe(type, MODEL_SHAPES[fit.id], fit);
    airframes.set(type, fitted);
    return fitted;
  }
  const p = PROPORTIONS[type.id] ?? (type.body === 'wide' || type.body === 'super' ? WIDE : NARROW);
  const L = type.length;
  const half = L / 2;
  const ry = type.fuselage / 2;
  const rz = ry * p.tall;
  // The fuselage rides on its gear: belly clear of the ground by roughly half its width.
  const zc = rz + Math.max(1.35, ry * 0.92);
  const noseLength = type.fuselage * 1.55;
  const tailLength = type.fuselage * 2.9;

  const stations: [number, number, number, number][] = [];
  const tailSteps = 6;
  for (let i = 0; i <= tailSteps; i += 1) {
    const t = i / tailSteps;
    const fat = Math.pow(t, 0.72);
    // The tail cone tapers and sweeps up so the aircraft can rotate without scraping.
    stations.push([-half + tailLength * t, zc + rz * 0.62 * (1 - fat), Math.max(0.18, ry * fat), Math.max(0.24, rz * (0.3 + 0.7 * fat))]);
  }
  const noseSteps = 6;
  const noseStart = half - noseLength;
  stations.push([(-half + tailLength + noseStart) / 2, zc, ry, rz]);
  for (let i = 0; i <= noseSteps; i += 1) {
    const t = i / noseSteps;
    const r = Math.sqrt(Math.max(0, 1 - t * t));
    stations.push([noseStart + noseLength * t, zc - rz * 0.16 * t * t, Math.max(0.12, ry * r), Math.max(0.12, rz * r)]);
  }

  const semi = type.span / 2;
  const wingRoot = ry * 0.6;
  const rootChord = type.span * p.rootChord;
  const tipChord = rootChord * p.taper;
  const wingX = half - L * p.wingAt;
  const wingZ = zc - rz * 0.62;
  const dihedral = 0.1;
  const tipX = wingX - Math.tan(p.sweep) * (semi - ry * 0.6);
  const tipZ = wingZ + Math.tan(dihedral) * (semi - ry * 0.6);

  const stabSpan = type.span * 0.19;
  const stabRoot = rootChord * 0.56;
  const stabX = -half + stabRoot * 1.32;
  const sideOf = (side: 1 | -1): Side => {
    const engines: Engine[] = [];
    // Engines hang ahead of and below the wing.
    for (const at of p.engineAt) {
      const y = side * semi * at;
      const along = (Math.abs(y) - ry * 0.6) / (semi - ry * 0.6);
      const leX = wingX + (tipX - wingX) * along;
      const leZ = wingZ + (tipZ - wingZ) * along;
      const r = p.engineRadius;
      const front = leX + p.engineLength * 0.62;
      const back = front - p.engineLength;
      const ez = Math.max(r + 0.55, leZ - r * 0.95);
      const stations: [number, number, number, number][] = [
        [back, ez, r * 0.5, r * 0.5],
        [back + p.engineLength * 0.35, ez, r * 0.86, r * 0.86],
        [front - p.engineLength * 0.18, ez, r, r],
        [front, ez, r * 0.92, r * 0.92],
      ];
      engines.push({ y, stations, front, radius: r, z: ez, leX, leZ, length: p.engineLength });
    }
    return {
      side,
      wing: { root: [wingX, side * ry * 0.6, wingZ], rootChord, rootThick: rootChord * 0.13, tip: [tipX, side * semi, tipZ], tipChord, tipThick: tipChord * 0.1, upright: false },
      winglet: p.winglet > 0 ? { root: [tipX, side * semi, tipZ], rootChord: tipChord, rootThick: 0.14, tip: [tipX - p.winglet * 0.7, side * (semi + p.winglet * 0.18), tipZ + p.winglet], tipChord: tipChord * 0.45, tipThick: 0.08, upright: true } : null,
      engines,
      stabiliser: { root: [stabX, side * ry * 0.35, zc + rz * 0.3], rootChord: stabRoot, rootThick: stabRoot * 0.1, tip: [stabX - Math.tan(0.6) * stabSpan, side * stabSpan, zc + rz * 0.3 + stabSpan * 0.12], tipChord: stabRoot * 0.38, tipThick: stabRoot * 0.05, upright: false },
    };
  };

  const finHeight = Math.max(3, type.height - (zc + rz * 0.75));
  const finRoot = L * 0.155;
  const finX = -half + finRoot * 1.18;
  const fin: Surface = { root: [finX, 0, zc + rz * 0.72], rootChord: finRoot, rootThick: finRoot * 0.11, tip: [finX - Math.tan(0.72) * finHeight, 0, zc + rz * 0.72 + finHeight], tipChord: finRoot * 0.36, tipThick: finRoot * 0.04, upright: true };

  const wheelR = Math.max(0.42, type.fuselage * 0.14);
  const built: Airframe = {
    type,
    half,
    ry,
    rz,
    zc,
    tall: p.tall,
    noseLength,
    tailLength,
    noseStart,
    stations,
    windows: { from: -half + tailLength * 0.95, to: noseStart + noseLength * 0.18, z: zc + rz * 0.22, y: ry * 0.985 + 0.02 },
    deckX: noseStart + noseLength * 0.52,
    semi,
    wingRoot,
    rootChord,
    tipChord,
    wingX,
    wingZ,
    tipX,
    tipZ,
    sides: [sideOf(1), sideOf(-1)],
    fin,
    wheelR,
    // The front door this share of the length behind the nose, at least 4.2 m; the rear one 19% of
    // it ahead of the tail; sills a fifth of the way down the fuselage's half height.
    doors: { front: { x: half - Math.max(4.2, 0.12 * L), sill: zc - rz * 0.2 }, rear: { x: -half + 0.19 * L, sill: zc - rz * 0.2 } },
    noseGearX: half - L * 0.12,
    mainGearX: half - L * 0.55,
    track: Math.min(semi * 0.36, Math.max(2.6, type.fuselage * 0.95)),
    bogies: type.body === 'wide' || type.body === 'super' ? [-wheelR * 1.25, wheelR * 1.25] : [0],
  };
  airframes.set(type, built);
  return built;
}

/** A type's shape from its model's, scaled as the model is drawn for it (see modelFit). */
function fittedAirframe(type: AirframeType, shape: ModelShape, fit: { along: number; across: number; up: number; mid: number }): Airframe {
  const ax = (x: number): number => (x - fit.mid) * fit.along;
  const L = type.length;
  const half = L / 2;
  const ry = shape.half * fit.across;
  const zc = ((shape.cabin[0] + shape.cabin[1]) / 2) * fit.up;
  const rz = ((shape.cabin[1] - shape.cabin[0]) / 2) * fit.up;
  // The fuselage as a tube of the cabin's height, as wide as the model's outline at each point.
  const stations = shape.body.map(([x, w]): [number, number, number, number] => [ax(x), zc, w * fit.across, rz]);
  const narrows = (from: number, step: number): number => {
    const order = step > 0 ? stations : [...stations].reverse();
    for (const st of order) if (st[2] >= ry * 0.95) return st[0];
    return from;
  };
  const noseStart = narrows(half, -1);
  const tailEnd = narrows(-half, 1);
  const surface = (s: ModelShape['wing'], side: 1 | -1): Surface => ({
    root: [ax(s.root[0]), side * s.root[1] * fit.across, s.root[2] * fit.up],
    rootChord: s.rootChord * fit.along,
    rootThick: s.rootThick * fit.up,
    tip: [ax(s.tip[0]), side * s.tip[1] * fit.across, s.tip[2] * fit.up],
    tipChord: s.tipChord * fit.along,
    tipThick: s.tipThick * fit.up,
    upright: false,
  });
  const sideOf = (side: 1 | -1): Side => {
    const wing = surface(shape.wing, side);
    const engines = shape.engines.map((e): Engine => {
      const y = side * e.y * fit.across;
      const z = e.z * fit.up;
      const radius = e.radius * Math.max(fit.across, fit.up);
      const front = ax(e.front);
      const back = ax(e.back);
      const le = surfaceOver(wing, y);
      return { y, stations: [[back, z, radius, radius], [front, z, radius, radius]], front, radius, z, leX: le?.lead ?? front, leZ: le ? (le.under + le.top) / 2 : z + radius, length: front - back };
    });
    return { side, wing, winglet: null, engines, stabiliser: surface(shape.stabiliser, side) };
  };
  const sides: [Side, Side] = [sideOf(1), sideOf(-1)];
  const finChord = (shape.fin.front - shape.fin.back) * fit.along;
  const fin: Surface = {
    root: [ax(shape.fin.front), 0, shape.cabin[1] * fit.up],
    rootChord: finChord,
    rootThick: 2 * shape.fin.half * fit.across,
    tip: [ax(shape.fin.back) + finChord * 0.4, 0, shape.fin.top * fit.up],
    tipChord: finChord * 0.4,
    tipThick: shape.fin.half * fit.across,
    upright: true,
  };
  const wing = sides[0].wing;
  return {
    type,
    half,
    ry,
    rz,
    zc,
    tall: rz / ry,
    noseLength: half - noseStart,
    tailLength: tailEnd + half,
    noseStart,
    stations,
    windows: { from: tailEnd, to: noseStart, z: zc + rz * 0.22, y: ry },
    deckX: noseStart + (half - noseStart) * 0.52,
    semi: type.span / 2,
    wingRoot: wing.root[1],
    rootChord: wing.rootChord,
    tipChord: wing.tipChord,
    wingX: wing.root[0],
    wingZ: wing.root[2],
    tipX: wing.tip[0],
    tipZ: wing.tip[2],
    sides,
    fin,
    doors: {
      front: { x: ax(shape.doors.front.x), sill: shape.doors.front.sill * fit.up },
      rear: { x: ax(shape.doors.rear.x), sill: shape.doors.rear.sill * fit.up },
    },
    // The main wheels as one block each side, as long and wide as the model's gear.
    wheelR: (shape.gear.halfLength * fit.along) / 0.9,
    noseGearX: ax(shape.gear.noseX),
    mainGearX: ax(shape.gear.mainX),
    track: shape.gear.track * fit.across,
    bogies: [0],
  };
}

/**
 * A surface's section at one end: a flat diamond, thickest a third of the way back. Its corners
 * are the leading edge, the top (or left, upright), the trailing edge and the bottom (or right).
 */
export function section(le: V3, chord: number, thick: number, upright: boolean): V3[] {
  const up: V3 = upright ? [0, thick / 2, 0] : [0, 0, thick / 2];
  const mid = chord * 0.32;
  return [
    [le[0], le[1], le[2]],
    [le[0] - mid + up[0], le[1] + up[1], le[2] + up[2]],
    [le[0] - chord, le[1], le[2]],
    [le[0] - mid - up[0], le[1] - up[1], le[2] - up[2]],
  ];
}

/**
 * A level surface (a wing or a tailplane) over a point `y` out from the centreline, as drawn:
 * where its leading and trailing edges are along x, and the heights of its underside and top
 * where it is thickest. Null beyond its tip or inside its root.
 */
export function surfaceOver(s: Surface, y: number): { lead: number; trail: number; under: number; top: number } | null {
  const from = Math.abs(s.root[1]);
  const to = Math.abs(s.tip[1]);
  const out = Math.abs(y);
  if (out > to || out < from) return null;
  const t = (out - from) / (to - from);
  const lead = s.root[0] + (s.tip[0] - s.root[0]) * t;
  const chord = s.rootChord + (s.tipChord - s.rootChord) * t;
  const z = s.root[2] + (s.tip[2] - s.root[2]) * t;
  const thick = s.rootThick + (s.tipThick - s.rootThick) * t;
  return { lead, trail: lead - chord, under: z - thick / 2, top: z + thick / 2 };
}

/**
 * The wing above a point `side` metres out from the centreline, as the model draws it: where its
 * leading and trailing edges are, in metres forward of the middle of the aircraft, and how high
 * its underside and top are where it is thickest. Inside the wing root, the root; null beyond
 * the wingtip.
 */
export function wingOver(type: AirframeType, side: number): { lead: number; trail: number; under: number; top: number } | null {
  const f = airframe(type);
  const wing = f.sides[0].wing;
  return surfaceOver(wing, Math.max(Math.abs(side), f.wingRoot));
}

/** The convex hull of points, as a polygon of x, y pairs, counter-clockwise. */
export function hull(points: readonly (readonly [number, number])[]): number[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: (readonly [number, number])[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flatMap((p) => [p[0], p[1]]);
}

/** A surface seen from above: the hull of its two sections. */
function surfacePlan(s: Surface): number[] {
  return hull([...section(s.root, s.rootChord, s.rootThick, s.upright), ...section(s.tip, s.tipChord, s.tipThick, s.upright)].map((p): [number, number] => [p[0], p[1]]));
}

/**
 * The aircraft seen from above as the model draws it: one convex polygon of x, y pairs per part,
 * in the body frame. The fuselage comes first (its tube, and the window bands, which stand a
 * little proud of it towards the nose and tail), then each side's wing, tip device, tailplane,
 * engines and main wheels, then the fin. The other parts drawn (the nose gear, pylons, intakes,
 * glazing) lie inside these.
 */
export function planOf(type: AirframeType): number[][] {
  const f = airframe(type);
  const body: [number, number][] = [];
  for (const [x, , ry] of f.stations) body.push([x, ry], [x, -ry]);
  for (const x of [f.windows.from, f.windows.to]) body.push([x, f.windows.y], [x, -f.windows.y]);
  const polygons = [hull(body)];
  for (const s of f.sides) {
    polygons.push(surfacePlan(s.wing));
    if (s.winglet) polygons.push(surfacePlan(s.winglet));
    polygons.push(surfacePlan(s.stabiliser));
    for (const e of s.engines) polygons.push(hull(e.stations.flatMap(([x, , r]): [number, number][] => [[x, e.y + r], [x, e.y - r]])));
    // The main wheels on this side, two abreast on each axle of the bogie.
    const y = s.side * f.track;
    const wheels: [number, number][] = [];
    for (const dx of f.bogies) {
      const x = f.mainGearX + dx;
      wheels.push([x - f.wheelR * 0.9, y - 0.42 - 0.42 / 2], [x + f.wheelR * 0.9, y + 0.42 + 0.42 / 2], [x - f.wheelR * 0.9, y + 0.42 + 0.42 / 2], [x + f.wheelR * 0.9, y - 0.42 - 0.42 / 2]);
    }
    polygons.push(hull(wheels));
  }
  polygons.push(surfacePlan(f.fin));
  return polygons;
}
