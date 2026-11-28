// The public halls that serve a stand, shared by passenger journeys and their curb traffic.
import type { Layout, Stand } from '../../shared/layout.ts';
import { buildTerminalPlan, type Place, type TerminalPlan } from './plan.ts';

export type PassengerHalls = Pick<TerminalPlan, 'holdroom' | 'claim' | 'customs' | 'checkpoint'>;

function nearestPlace(at: { x: number; y: number }, choices: Iterable<Place>): Place | undefined {
  let nearest: Place | undefined;
  let least = Infinity;
  for (const p of choices) {
    const distance = Math.hypot(p.x - at.x, p.y - at.y);
    if (distance < least) {
      nearest = p;
      least = distance;
    }
  }
  return nearest;
}

export function holdroomForStand(plan: PassengerHalls, stand: Stand): Place | undefined {
  return plan.holdroom.get(stand.id) ?? nearestPlace(stand, plan.holdroom.values());
}

/** A customs arrival at a gate without its own hall transfers to the nearest customs hall first. */
export function arrivalStart(plan: PassengerHalls, holdroom: Place, customs: boolean): Place {
  return customs && !plan.customs.has(holdroom.area) ? nearestPlace(holdroom, plan.customs.values()) ?? holdroom : holdroom;
}

// Road-only runs use the same hall locations without keeping the walking grids or simulating people.
const hallsForLayout = new WeakMap<Layout, PassengerHalls>();
export function passengerHalls(layout: Layout): PassengerHalls {
  let halls = hallsForLayout.get(layout);
  if (!halls) {
    const { holdroom, claim, customs, checkpoint } = buildTerminalPlan(layout);
    halls = { holdroom, claim, customs, checkpoint };
    hallsForLayout.set(layout, halls);
  }
  return halls;
}
