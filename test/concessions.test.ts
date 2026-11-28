import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim/config.ts';
import { Rng } from '../src/sim/rng.ts';
import { Concessions, tradingHours } from '../src/sim/terminal/concessions.ts';

const HOUR = 3600;
const staffed = () => true;
const cafe = { id: 1, kind: 'food', size: 120, area: 'F' } as const;

describe('concessions', () => {
  it('sells only available stock, while staffed and trading, and charges whole cents', () => {
    const now = 14 * HOUR;
    const shops = new Concessions([cafe], new Rng(7), now);
    const opening = shops.summary(now, staffed).stock;
    expect(shops.sell(1, 1, now, false)).toBeNull();
    expect(shops.sell(1, 1, 23.5 * HOUR, true)).toBeNull();
    expect(shops.sell(1, opening + 1, now, true)).toBeNull();
    expect(shops.sell(1, 1.5, now, true)).toBeNull();
    const sale = shops.sell(1, opening, now, true)!;
    expect(sale.area).toBe('F');
    expect(Number.isInteger(sale.cents)).toBe(true);
    expect(shops.summary(now, staffed)).toMatchObject({ open: 1, soldOut: 1, stock: 0, unitsSold: opening, revenue: sale.cents / 100 });
    expect(shops.sell(1, 1, now, true)).toBeNull();
    expect(shops.summary(now, () => false)).toMatchObject({ open: 0, soldOut: 0 });
    expect(tradingHours((5 - 24) * HOUR)).toBe(true);
    expect(tradingHours((23.5 - 24) * HOUR)).toBe(false);
  });

  it('bounds each concourse delivery and preserves every unit through stockouts and repeated clock ticks', () => {
    const outlets = Array.from({ length: 12 }, (_, i) => ({ ...cafe, id: i, area: i < 6 ? 'F' : 'G' }));
    const now = 6 * HOUR;
    const shops = new Concessions(outlets, new Rng(2), now);
    const opening = shops.summary(now, staffed).stock;
    for (const outlet of outlets) {
      while (shops.canServe(outlet.id, 1, now, true)) shops.sell(outlet.id, 1, now, true);
    }
    const at = 7.5 * HOUR;
    shops.advance(at - 0.5);
    expect(shops.summary(at, staffed)).toMatchObject({ deliveries: 0, soldOut: 12, stock: 0 });
    shops.advance(at);
    const received = shops.summary(at, staffed);
    expect(received.deliveries).toBe(2);
    expect(received.unitsDelivered).toBe(CONFIG.concessions.unitsPerLoad * 2);
    expect(received.stock).toBe(opening - received.unitsSold + received.unitsDelivered);
    shops.advance(at);
    expect(shops.summary(at, staffed)).toEqual(received);
    shops.advance(24 * HOUR + at);
    const nextDay = shops.summary(24 * HOUR + at, staffed);
    expect(nextDay.soldOut).toBe(0);
    expect(nextDay.stock).toBe(12 * Math.round(cafe.size * CONFIG.concessions.food.unitsPerSquareMetre));
    expect(nextDay.stock).toBe(opening - nextDay.unitsSold + nextDay.unitsDelivered);
  });

  it('starts mid-day with reproducible shelves and counts only subsequent deliveries', () => {
    const now = 14 * HOUR;
    const run = () => {
      const shops = new Concessions([cafe], new Rng(8), now);
      shops.advance(now);
      const start = shops.summary(now, staffed);
      shops.sell(1, 3, now, true);
      shops.advance(16.5 * HOUR);
      return [start, shops.summary(16.5 * HOUR, staffed)];
    };
    const [start, after] = run();
    expect(start).toMatchObject({ deliveries: 0, unitsSold: 0, unitsDelivered: 0 });
    expect(after).toMatchObject({ deliveries: 1, unitsSold: 3 });
    expect(run()).toEqual([start, after]);
  });

  it('serves shops skipped on the previous run when demand repeatedly empties the shelves', () => {
    const outlets = Array.from({ length: 4 }, (_, id) => ({ ...cafe, id, size: 300 }));
    const shops = new Concessions(outlets, new Rng(5), 6 * HOUR);
    const empty = (now: number) => {
      for (const { id } of outlets) {
        while (shops.canServe(id, 1, now, true)) shops.sell(id, 1, now, true);
      }
    };
    empty(6 * HOUR);
    const served = new Set<number>();
    for (const hour of [7.5, 10.5, 13.5, 16.5]) {
      const now = hour * HOUR;
      shops.advance(now);
      for (const { id } of outlets) if (shops.canServe(id, 1, now, true)) served.add(id);
      empty(now);
    }
    expect(served.size).toBe(outlets.length);
  });
});
