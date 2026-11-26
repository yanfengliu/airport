// The airport layout the simulation and the renderer share. Every file under public/data/ is one
// of these sections, generated from OpenStreetMap by tools/osm/build-layout.ts.
// Coordinates are local metres (x east, y north of the origin in geo.ts), rounded to 0.1 m.

/** A polyline or ring as x0, y0, x1, y1, ... */
export type Flat = number[];

export interface PolygonData {
  outer: Flat;
  holes?: Flat[];
}

// ---------------------------------------------------------------------------------------------
// Airfield

export interface RunwayEnd {
  /** The designator used when starting from this end, e.g. "28R". */
  name: string;
  /** The end of the pavement on the centreline. */
  x: number;
  y: number;
  /** How far the landing threshold sits in from the pavement end. */
  displaced: number;
}

export interface Runway {
  id: string;
  width: number;
  /** Pavement length between the two ends. */
  length: number;
  ends: [RunwayEnd, RunwayEnd];
}

export interface TaxiNode {
  x: number;
  y: number;
  /** A painted holding position: aircraft stop here until cleared onto the runway ahead. */
  hold?: 1;
  /** Runways whose centreline passes through this node. */
  rwy?: string[];
}

export type TaxiEdgeKind = 'rwy' | 'twy' | 'stand';

export interface TaxiEdge {
  a: number;
  b: number;
  pts: Flat;
  len: number;
  kind: TaxiEdgeKind;
  /** Taxiway letter, e.g. "A" or "M1". */
  ref?: string;
  /** Runway id for kind "rwy". */
  rwy?: string;
}

export interface Stand {
  /** Gate number such as "A1", or a generated id such as "R12" for a remote stand. */
  id: string;
  /** Boarding area letter for a terminal gate; otherwise the apron group. */
  area: string;
  /** True for a gate with a jet bridge and a terminal door. */
  contact: boolean;
  /** Where the nose wheel stops. */
  x: number;
  y: number;
  /** Direction the parked aircraft faces, radians from east, counter-clockwise. */
  heading: number;
  /** Graph node at the nose stop point. */
  node: number;
  /** Largest wingspan that fits, metres. */
  span: number;
  /** Terminal door for passengers: x, y. */
  door?: [number, number];
  /** Jet bridge centreline from the terminal towards the aircraft. */
  bridge?: Flat;
}

export interface Apron {
  name?: string;
  poly: PolygonData;
}

export interface Airfield {
  runways: Runway[];
  nodes: TaxiNode[];
  edges: TaxiEdge[];
  stands: Stand[];
  aprons: Apron[];
  /** Blast pads beyond the runway ends, as centrelines; they are as wide as the runway. */
  stopways: Flat[];
  helipads: [number, number][];
  tower: [number, number];
}

// ---------------------------------------------------------------------------------------------
// Terminals

export interface TerminalBuilding {
  id: string;
  name: string;
  poly: PolygonData;
  height: number;
  minHeight: number;
}

export interface NamedArea {
  name?: string;
  level?: number;
  poly: PolygonData;
}

export interface Poi {
  kind: string;
  name?: string;
  x: number;
  y: number;
  level?: number;
}

export interface Terminals {
  buildings: TerminalBuilding[];
  checkin: NamedArea[];
  claims: NamedArea[];
  pois: Poi[];
}

// ---------------------------------------------------------------------------------------------
// Roads

export type RoadClass =
  | 'motorway'
  | 'motorway_link'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'local'
  | 'service'
  | 'airside';

export interface RoadNode {
  x: number;
  y: number;
  /** Height above ground, metres. */
  z: number;
  /** Traffic signal at this junction. */
  signal?: 1;
}

export interface RoadEdge {
  a: number;
  b: number;
  /** x, y, z triples. */
  pts: number[];
  len: number;
  cls: RoadClass;
  /** Lanes in the a→b direction. */
  lanes: number;
  /** Lanes in the b→a direction; 0 for a one-way road. */
  back: number;
  /** Speed limit, m/s. */
  speed: number;
  name?: string;
  /** Carried on a structure above ground. */
  bridge?: 1;
  tunnel?: 1;
}

export interface Roads {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

// ---------------------------------------------------------------------------------------------
// Rail

export interface RailLine {
  kind: 'airtrain' | 'bart' | 'caltrain';
  /** x, y, z triples. */
  pts: number[];
  name?: string;
}

export interface RailStation {
  kind: 'airtrain' | 'bart' | 'caltrain';
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface Rail {
  lines: RailLine[];
  stations: RailStation[];
}

// ---------------------------------------------------------------------------------------------
// Buildings and land

export type BuildingKind = 'generic' | 'hangar' | 'garage' | 'cargo' | 'hotel' | 'tower' | 'house' | 'industrial' | 'office';

export interface Building {
  kind: BuildingKind;
  name?: string;
  poly: PolygonData;
  height: number;
  minHeight?: number;
}

export interface Buildings {
  buildings: Building[];
}

export type SurfaceKind = 'grass' | 'wetland' | 'water' | 'parking' | 'pavement' | 'sand' | 'scrub' | 'industrial' | 'residential' | 'park';

export interface Surface {
  kind: SurfaceKind;
  name?: string;
  poly: PolygonData;
}

export interface Land {
  /** Half-extent of the square world the renderer draws, centred on the origin. */
  bounds: [number, number, number, number];
  /** Dry land, including the fill the runways sit on. Everything else is the bay. */
  land: PolygonData[];
  surfaces: Surface[];
  /** The aerodrome boundary. */
  airport: PolygonData[];
  piers: Flat[];
}

export interface Provenance {
  source: string;
  license: string;
  attribution: string;
  osmBase: string;
  bbox: [number, number, number, number];
  origin: { lat: number; lon: number };
  themes: Record<string, { query: string; elements: number; bytes: number; sha256: string; fetchedAt: string; endpoint: string }>;
  generatedBy: string;
}

export interface Layout {
  airfield: Airfield;
  terminals: Terminals;
  roads: Roads;
  rail: Rail;
  buildings: Buildings;
  land: Land;
}

export const LAYOUT_FILES = ['airfield', 'terminals', 'roads', 'rail', 'buildings', 'land'] as const;
export type LayoutSection = (typeof LAYOUT_FILES)[number];
