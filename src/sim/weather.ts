// The weather over the airport, and the runways it calls for. Wind decides which way aircraft land
// and take off: San Francisco lands on 28L and 28R and takes off from 1L and 1R (the West Plan)
// while the wind is westerly, as it is most of the year, and turns to land on 19L and 19R and take
// off from 10L and 10R (the Southeast Plan) when a storm brings wind from the southeast. Low cloud
// or fog rules out landing side by side on the two parallel runways, which are 750 feet apart.

import { SOUTHEAST_PLAN, WEST_PLAN, type RunwayPlan } from './airside/tower.ts';
import { CONFIG } from './config.ts';

export interface Weather {
  /** Direction the wind blows from, degrees, and its speed, knots. */
  windFrom: number;
  windKnots: number;
  /** Visibility, statute miles, and the cloud ceiling, feet. */
  visibility: number;
  ceiling: number;
}

/** An ordinary San Francisco afternoon: the sea breeze from the west, clear. */
export const CLEAR_WEST: Weather = { windFrom: 290, windKnots: 14, visibility: 10, ceiling: 25_000 };

/** Named weather the operations panel offers. */
export const WEATHER_PRESETS: { id: string; label: string; weather: Weather }[] = [
  { id: 'clear', label: 'Clear, west wind', weather: CLEAR_WEST },
  { id: 'low-cloud', label: 'Low cloud', weather: { windFrom: 280, windKnots: 8, visibility: 6, ceiling: 1_200 } },
  { id: 'fog', label: 'Fog', weather: { windFrom: 270, windKnots: 4, visibility: 0.75, ceiling: 300 } },
  { id: 'storm', label: 'Southeast storm', weather: { windFrom: 150, windKnots: 24, visibility: 4, ceiling: 1_800 } },
];

/** Heading of runway 28L/28R, degrees. */
const HEADING_28 = 284;
const { turnSoutheast: TURN_SOUTHEAST, turnWest: TURN_WEST, pairedCeiling: PAIRED_CEILING, pairedVisibility: PAIRED_VISIBILITY } = CONFIG.weather;

/** Wind along the 28s from behind, knots: negative when it is a headwind. */
export function tailwindOn28(weather: Weather): number {
  return -weather.windKnots * Math.cos(((weather.windFrom - HEADING_28) * Math.PI) / 180);
}

/**
 * The runway plan the weather calls for, given the plan in use: the airport changes plan only when
 * the wind has clearly turned, not back and forth on every gust.
 */
export function planFor(weather: Weather, current: RunwayPlan): RunwayPlan {
  const tail = tailwindOn28(weather);
  if (current.name === 'West') return tail > TURN_SOUTHEAST ? SOUTHEAST_PLAN : WEST_PLAN;
  return tail < TURN_WEST ? WEST_PLAN : SOUTHEAST_PLAN;
}

/** Can arrivals land side by side on the two parallel runways? */
export function pairedApproaches(weather: Weather): boolean {
  return weather.ceiling >= PAIRED_CEILING && weather.visibility >= PAIRED_VISIBILITY;
}
