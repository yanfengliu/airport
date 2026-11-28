import type { IndoorFloor, Terminals } from '../../shared/layout.ts';
import { insidePolygon } from './fittings.ts';
import { FLOOR, type Place } from './plan.ts';

/** The building's mapped level numbers for public places, calibrated against its own passenger halls. */
export function mappedFloors(terminals: Terminals, places: Place[]) {
  const buildingAt = (x: number, y: number) => terminals.buildings.find((b) => insidePolygon(b.poly, x, y));
  const levels = new Map<string, Set<IndoorFloor>>();
  for (const place of places) {
    if (place.room < 0 || !['claim', 'checkin', 'food', 'shop'].includes(place.kind)) continue;
    const building = buildingAt(place.x, place.y);
    if (!building) continue;
    const key = building.id + ':' + terminals.areas[place.room].level;
    const floors = levels.get(key) ?? new Set<IndoorFloor>();
    floors.add(place.floor === FLOOR.arrivals ? 'arrivals' : 'departures');
    levels.set(key, floors);
  }
  const locate = (x: number, y: number, level: number) => {
    const building = buildingAt(x, y);
    if (!building) return;
    const floors = levels.get(building.id + ':' + level);
    if (floors?.size !== 1) return;
    const [floor] = floors;
    return { building, floor };
  };
  const restrooms = new Map<number, NonNullable<ReturnType<typeof locate>> & { x: number; y: number }>();
  const rooms = terminals.areas.map((area, i): IndoorFloor => {
    if (area.kind === 'claim') return 'arrivals';
    if (area.kind === 'toilets') {
      const ring = area.poly.outer;
      let x = 0, y = 0;
      for (let j = 0; j < ring.length; j += 2) { x += ring[j]; y += ring[j + 1]; }
      x /= ring.length / 2;
      y /= ring.length / 2;
      const found = locate(x, y, area.level);
      if (found) {
        if (insidePolygon(area.poly, x, y)) restrooms.set(i, { x, y, ...found });
        return found.floor;
      }
    }
    return 'departures';
  });
  return { locate, rooms, restrooms };
}
