// How wide a road is drawn and where its lanes lie, shared by the renderer (which paints the
// lanes) and the traffic simulation (which drives in them).

import type { RoadClass, RoadEdge } from './layout.ts';

export const LANE_WIDTH: Record<RoadClass, number> = {
  motorway: 3.7,
  motorway_link: 3.9,
  trunk: 3.6,
  primary: 3.5,
  secondary: 3.4,
  tertiary: 3.3,
  local: 3.2,
  service: 3,
  airside: 3,
};

export const SHOULDER: Record<RoadClass, number> = {
  motorway: 2.6,
  motorway_link: 1.6,
  trunk: 1.2,
  primary: 0.8,
  secondary: 0.6,
  tertiary: 0.5,
  local: 0.4,
  service: 0.3,
  airside: 0.3,
};

/** Paved width of an edge: all lanes both ways plus both shoulders. */
export function roadWidth(e: Pick<RoadEdge, 'cls' | 'lanes' | 'back'>): number {
  return (e.lanes + e.back) * LANE_WIDTH[e.cls] + 2 * SHOULDER[e.cls];
}

/**
 * Sideways offset of a lane's centre from the edge's centreline, positive to the right of the
 * direction of travel. `lane` counts from the left of that direction; `own` and `opposing` are
 * the lane counts in the direction of travel and against it.
 */
export function laneOffset(cls: RoadClass, own: number, opposing: number, lane: number): number {
  return ((opposing - own) / 2 + lane + 0.5) * LANE_WIDTH[cls];
}
