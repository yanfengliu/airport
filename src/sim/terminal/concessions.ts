import { CONFIG } from '../config.ts';
import type { Rng } from '../rng.ts';
import { DAY } from '../schedule.ts';
import type { Place } from './plan.ts';

type OutletKind = 'shop' | 'food';

interface Outlet {
  id: number;
  kind: OutletKind;
  area: string;
  capacity: number;
  stock: number;
  lastDelivery: number;
}

export interface ConcessionSummary {
  outlets: number;
  /** Open and staffed, including outlets temporarily sold out. */
  open: number;
  soldOut: number;
  stock: number;
  unitsSold: number;
  unitsDelivered: number;
  /** Concourse delivery loads received since the start. */
  deliveries: number;
  /** Dollars taken since the start. */
  revenue: number;
}

const settings = CONFIG.concessions;

export function tradingHours(now: number): boolean {
  const hour = (((now % DAY) + DAY) % DAY) / 3600;
  return hour >= CONFIG.staff.shopsOpen[0] && hour < CONFIG.staff.shopsOpen[1];
}

/** At startup a run due exactly now is still to unload. */
function nextDelivery(now: number, starting = false): number {
  const midnight = Math.floor(now / DAY) * DAY;
  for (const hour of settings.deliveryHours) {
    const at = midnight + hour * 3600;
    if (at > now || (starting && at === now)) return at;
  }
  return midnight + DAY + settings.deliveryHours[0] * 3600;
}

export class Concessions {
  private readonly outlets = new Map<number, Outlet>();
  private readonly routes = new Map<string, Outlet[]>();
  private readonly rng: Rng;
  private nextDelivery: number;
  private deliveries = 0;
  private unitsDelivered = 0;
  private unitsSold = 0;
  private revenueCents = 0;

  constructor(places: readonly Pick<Place, 'id' | 'kind' | 'area' | 'size'>[], rng: Rng, now: number) {
    this.rng = rng;
    this.nextDelivery = nextDelivery(now, true);
    for (const place of places) {
      if (place.kind !== 'food' && place.kind !== 'shop') continue;
      const sizes = settings[place.kind];
      const capacity = Math.round(Math.max(sizes.minCapacity, Math.min(sizes.maxCapacity, place.size * sizes.unitsPerSquareMetre)));
      const stock = Math.round(capacity * rng.range(...settings.openingFill));
      const outlet = { id: place.id, kind: place.kind, area: place.area, capacity, stock, lastDelivery: -Infinity };
      this.outlets.set(place.id, outlet);
      const route = this.routes.get(place.area) ?? [];
      route.push(outlet);
      this.routes.set(place.area, route);
    }
  }

  /** The receiving dock sends the least stocked outlets in each concourse their top-ups first. */
  advance(now: number): void {
    while (now >= this.nextDelivery) {
      for (const outlets of this.routes.values()) {
        // Two equally empty shops take turns, even when the first shop sells its entire delivery.
        outlets.sort((a, b) => a.stock / a.capacity - b.stock / b.capacity || a.lastDelivery - b.lastDelivery || a.id - b.id);
        let remaining: number = settings.unitsPerLoad;
        for (const outlet of outlets) {
          const units = Math.min(remaining, outlet.capacity - outlet.stock);
          outlet.stock += units;
          if (units) outlet.lastDelivery = this.nextDelivery;
          remaining -= units;
          if (!remaining) break;
        }
        const received = settings.unitsPerLoad - remaining;
        if (received) {
          this.deliveries += 1;
          this.unitsDelivered += received;
        }
      }
      this.nextDelivery = nextDelivery(this.nextDelivery);
    }
  }

  canServe(id: number, size: number, now: number, staffed: boolean): boolean {
    return staffed && tradingHours(now) && Number.isSafeInteger(size) && size > 0 && (this.outlets.get(id)?.stock ?? 0) >= size;
  }

  /** A party checks out together. Charge it only for items actually taken from a staffed shop. */
  sell(id: number, size: number, now: number, staffed: boolean): { area: string; cents: number } | null {
    if (!this.canServe(id, size, now, staffed)) return null;
    const outlet = this.outlets.get(id)!;
    const [low, high] = settings[outlet.kind].dollars;
    const cents = size * Math.round(this.rng.range(low, high) * 100);
    outlet.stock -= size;
    this.unitsSold += size;
    this.revenueCents += cents;
    return { area: outlet.area, cents };
  }

  summary(now: number, staffed: (id: number) => boolean): ConcessionSummary {
    let open = 0;
    let soldOut = 0;
    let stock = 0;
    const trading = tradingHours(now);
    for (const outlet of this.outlets.values()) {
      stock += outlet.stock;
      if (!trading || !staffed(outlet.id)) continue;
      open += 1;
      if (!outlet.stock) soldOut += 1;
    }
    return { outlets: this.outlets.size, open, soldOut, stock, unitsSold: this.unitsSold, unitsDelivered: this.unitsDelivered, deliveries: this.deliveries, revenue: this.revenueCents / 100 };
  }
}
