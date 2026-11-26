// Ground on a runway is the tower's, whatever line the map draws on it. At 3001b2e taxiway T was
// mapped along the pavement of 28R for 200 m with no runway node on it, so aircraft taxied on the
// runway without a clearance and met landings and take-offs there. Bound: every taxiway block in
// the committed layout, followed by a mid-size aircraft; these read public/data as committed.

import { describe, expect, it } from 'vitest';
import { TaxiNet } from '../src/sim/airfield/net.ts';
import { arcPieces, buildPath } from '../src/sim/airfield/path.ts';
import { runwayStretches } from '../src/sim/airside/aircraft.ts';
import { CONFIG } from '../src/sim/config.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

const net = new TaxiNet(loadLayoutFromDisk().airfield);

describe('runway strips', () => {
  it('finds every stretch of taxiway that lies on a runway', () => {
    const misses: string[] = [];
    let onPavement = 0;
    for (const block of net.blocks) {
      if (block.kind !== 'twy') continue;
      const path = buildPath(net, arcPieces(net, [block.id * 2]), { length: 40, front: 3, reversing: false }, 0);
      const stretches = runwayStretches(net, path, 0);
      for (const info of net.runwayEnds.values()) {
        const r = info.runway;
        let on = false;
        for (let i = 0; i < block.pts.length; i += 2) {
          const dx = block.pts[i] - info.end.x;
          const dy = block.pts[i + 1] - info.end.y;
          const along = dx * info.ux + dy * info.uy;
          const across = Math.abs(-dx * info.uy + dy * info.ux);
          if (across < CONFIG.runway.strip - 2 && along > 0 && along < r.length) on = true;
        }
        if (!on) continue;
        onPavement += 1;
        if (!stretches.some((s) => s.runway === r.id)) misses.push(`block ${block.id} (${block.ref ?? 'unnamed'}) on ${r.id}`);
      }
    }
    // The layout has taxiways on runway pavement: crossings, turn-offs, and T, Q and K along 28R.
    expect(onPavement).toBeGreaterThan(50);
    expect(misses).toEqual([]);
  });

  it('puts taxiway T on runway 28R where it runs along the pavement', () => {
    const t = net.blocks.filter((b) => b.kind === 'twy' && b.ref === 'T');
    const alongside = t.filter((b) => {
      const path = buildPath(net, arcPieces(net, [b.id * 2]), { length: 40, front: 3, reversing: false }, 0);
      return runwayStretches(net, path, 0).some((s) => s.runway === '10L/28R' && s.enter === -Infinity);
    });
    // At least the two blocks of T with no runway node at either end that lie within metres of the centreline.
    expect(alongside.length).toBeGreaterThanOrEqual(2);
  });
});
