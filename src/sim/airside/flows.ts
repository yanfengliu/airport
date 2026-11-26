// The habits of ground traffic: which way round the terminal each ring taxiway is used.
//
// Taxiways A and B run side by side round the terminal. Used both ways at once they bring aircraft
// nose to nose with nowhere to go, so, as at the real airport, each is taken one way: A, the
// inner one, clockwise, and B, the outer one, counter-clockwise. Going against the flow is not
// forbidden outright, since a few stands can only be reached that way, but it costs so much that
// a route does it only when nothing else will do.

import type { TaxiNet } from '../airfield/net.ts';

/** Seconds of route cost for each block taken against the flow. */
const AGAINST = 400;

const RINGS: Record<string, 1 | -1> = { A: -1, B: 1 };

/** Extra cost of each arc, indexed by arc. */
export function flowCosts(net: TaxiNet): Float32Array {
  const costs = new Float32Array(net.blocks.length * 2);
  // The middle of the terminal: the gates stand all round it.
  let cx = 0;
  let cy = 0;
  let count = 0;
  for (const stand of net.stands.values()) {
    if (!stand.contact) continue;
    cx += stand.x;
    cy += stand.y;
    count += 1;
  }
  if (!count) return costs;
  cx /= count;
  cy /= count;
  for (const block of net.blocks) {
    const sense = block.ref ? RINGS[block.ref] : undefined;
    if (!sense || block.kind !== 'twy') continue;
    const n = block.pts.length;
    const mx = (block.pts[0] + block.pts[n - 2]) / 2 - cx;
    const my = (block.pts[1] + block.pts[n - 1]) / 2 - cy;
    const dx = block.pts[n - 2] - block.pts[0];
    const dy = block.pts[n - 1] - block.pts[1];
    // Positive when a→b goes counter-clockwise about the middle.
    const turning = mx * dy - my * dx;
    if (Math.abs(turning) < 0.2 * Math.hypot(mx, my) * Math.hypot(dx, dy)) continue;
    const forward = Math.sign(turning) === sense;
    costs[block.id * 2 + (forward ? 1 : 0)] = AGAINST;
  }
  return costs;
}
