// FlySFO's printable passenger maps group the boarding areas this way.
// https://www.flysfo.com/maps/static-maps
import { COURTYARD_3, courtyard3 } from '../shared/courtyard3.ts';
import { ringCentroid, type Vec2 } from '../shared/geo.ts';
import type { IndoorFloor, Layout, PolygonData } from '../shared/layout.ts';
import { insidePolygon } from '../sim/terminal/fittings.ts';
import { FLOOR, type Place, type TerminalPlan } from '../sim/terminal/plan.ts';

const files = 'https://www.flysfo.com/sites/default/files/';
export const PASSENGER_TERMINALS = [
  { name: 'Harvey Milk Terminal 1', map: files + '2025-11/251027_SFO_Tabloid_Face%20A_T1_Web.pdf', gates: 'BC', buildings: ['Harvey Milk Terminal 1', 'Boarding Area C'] },
  { name: 'Terminal 2', map: files + '2025-11/251027_SFO_Tabloid_Face%20A_T2_Web.pdf', gates: 'D', buildings: ['Terminal 2'] },
  { name: 'Terminal 3', map: files + '2025-11/251027_SFO_Tabloid_Face%20A_T3_Web.pdf', gates: 'EF', buildings: ['Terminal 3'] },
  { name: 'Dianne Feinstein International Terminal', map: files + '2026-09/260701_SFO_Tabloid_Face%20A_INTL_WEB.pdf', gates: 'AG', buildings: ['International Boarding Area A', 'International Boarding Area G', 'International Terminal Main Hall'] },
];

export interface MapDestination {
  name: string;
  group: string;
  x: number;
  y: number;
  floor: IndoorFloor;
  room?: PolygonData;
}

export interface PassengerMap {
  outline: PolygonData[];
  destinations: MapDestination[];
}

const GROUP: Partial<Record<Place['kind'], string>> = {
  holdroom: 'Gates', checkpoint: 'Checkpoints', claim: 'Baggage claim', checkin: 'Check-in',
  food: 'Dining', shop: 'Shops', lounge: 'Lounges', airtrain: 'Rail connections', bart: 'Rail connections',
};

export function passengerMaps(layout: Layout, plan: TerminalPlan): PassengerMap[] {
  const maps = PASSENGER_TERMINALS.map((t) => ({
    outline: layout.terminals.buildings.filter((b) => t.buildings.includes(b.name)).map((b) => b.poly),
    destinations: [] as MapDestination[],
  }));
  const gallery = courtyard3(layout.terminals);
  if (gallery) {
    const ring: Vec2[] = [];
    for (let i = 0; i < gallery.outer.length; i += 2) ring.push([gallery.outer[i], gallery.outer[i + 1]]);
    const [x, y] = ringCentroid(ring);
    for (const index of [1, 2]) maps[index].destinations.push({ name: COURTYARD_3, group: 'Terminal connections', x, y, floor: 'departures', room: gallery });
  }
  const gates = [...plan.holdroom.values()];
  for (const p of plan.places) {
    const group = GROUP[p.kind];
    if (!group) continue;
    // Limit the directory to public destinations actually present in the imported layout.
    if ((p.kind === 'checkin' || p.kind === 'claim' || p.kind === 'food' || p.kind === 'shop' || p.kind === 'lounge') && p.room < 0) continue;
    let terminal = p.area ? PASSENGER_TERMINALS.findIndex((t) => t.gates.includes(p.area)) : -1;
    if (terminal < 0) terminal = maps.findIndex((m) => m.outline.some((b) => insidePolygon(b, p.x, p.y)));
    if (terminal < 0) {
      // Station walkways and points rounded to the walking grid can land outside the hall footprint.
      const near = gates.reduce<Place | undefined>((best, gate) => !best || Math.hypot(p.x - gate.x, p.y - gate.y) < Math.hypot(p.x - best.x, p.y - best.y) ? gate : best, undefined);
      terminal = near ? PASSENGER_TERMINALS.findIndex((t) => t.gates.includes(near.area)) : -1;
    }
    if (terminal < 0) continue;
    const name = p.kind === 'airtrain' ? 'AirTrain · ' + p.name : p.kind === 'bart' ? 'BART station connection' : p.name;
    const destination: MapDestination = { name, group, x: p.x, y: p.y, floor: p.floor === FLOOR.arrivals ? 'arrivals' : 'departures', room: layout.terminals.areas[p.room]?.poly };
    maps[terminal].destinations.push(destination);
    if (p.kind === 'airtrain' && p.name === 'Terminals 2 and 3') {
      // Either terminal directs its passengers to the shared station walkway.
      const other = terminal === 1 ? 2 : 1;
      maps[other].destinations.push({ ...destination });
    }
  }
  // A POI level means different things in different buildings. Match it to a known passenger
  // floor in its own building. Skip uncorroborated levels, including mezzanines.
  const addAmenity = (name: string, group: string, x: number, y: number, location: ReturnType<typeof plan.mappedFloors.locate>, room?: PolygonData): void => {
    if (!location) return;
    const { building, floor } = location;
    const terminal = PASSENGER_TERMINALS.findIndex((t) => t.buildings.includes(building.name));
    if (terminal < 0) return;
    if (layout.terminals.closed?.some((r) => r.floor === floor && insidePolygon(r.poly, x, y))) return;
    maps[terminal].destinations.push({ name, group, floor, x, y, room });
  };
  for (const p of layout.terminals.pois) {
    if (p.kind === 'art' && p.name) addAmenity(p.name, 'Public art', p.x, p.y, plan.mappedFloors.locate(p.x, p.y, p.level));
  }
  for (const [i, p] of plan.mappedFloors.restrooms) {
    const room = layout.terminals.areas[i];
    addAmenity(room.name || 'Restrooms', 'Restrooms', p.x, p.y, p, room.poly);
  }
  for (const map of maps) {
    // Several tenants have more than one branch; distinguish their counters by the nearest gate.
    const count = new Map<string, number>();
    for (const p of map.destinations) count.set(p.name, (count.get(p.name) ?? 0) + 1);
    const localGates = map.destinations.filter((p) => p.group === 'Gates');
    for (const p of map.destinations) {
      if ((count.get(p.name) ?? 0) <= 1 || !localGates.length) continue;
      const nearest = localGates.reduce((a, b) => Math.hypot(p.x - a.x, p.y - a.y) <= Math.hypot(p.x - b.x, p.y - b.y) ? a : b);
      p.name += ' · near ' + nearest.name;
    }
    // When adjoining rooms share a passenger-facing name and gate, one listing can direct
    // a visitor there. Keep separate locations that happen to share a label farther apart.
    const distinct: MapDestination[] = [];
    for (const p of map.destinations) {
      if (!distinct.some((q) => q.group === p.group && q.name === p.name && q.floor === p.floor && Math.hypot(q.x - p.x, q.y - p.y) < 18)) distinct.push(p);
    }
    map.destinations = distinct;
    map.destinations.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  }
  return maps;
}
