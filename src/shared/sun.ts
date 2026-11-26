// Where the sun is over SFO for a clock time, close enough for lighting and for deciding when
// lights come on. The simulated day is an equinox day on daylight time.

import { ORIGIN_LAT } from './geo.ts';

const DEG = Math.PI / 180;
/** 21 September. */
const DAY_OF_YEAR = 264;
/** Clock minus solar time on that day: daylight saving, west of the zone meridian, equation of time. */
const CLOCK_MINUS_SOLAR_S = 62.5 * 60;

export interface SunPosition {
  /** Radians above the horizon; negative at night. */
  elevation: number;
  /** Radians clockwise from north. */
  azimuth: number;
  /** Unit vector towards the sun: east, north, up. */
  dir: [number, number, number];
}

export function sunAt(secondsOfDay: number): SunPosition {
  const declination = 23.44 * DEG * Math.sin((2 * Math.PI * (284 + DAY_OF_YEAR)) / 365);
  const solarHours = (secondsOfDay - CLOCK_MINUS_SOLAR_S) / 3600;
  const hourAngle = 15 * DEG * (solarHours - 12);
  const lat = ORIGIN_LAT * DEG;
  const sinEl = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)) + Math.PI;
  const cosEl = Math.cos(elevation);
  return { elevation, azimuth, dir: [Math.sin(azimuth) * cosEl, Math.cos(azimuth) * cosEl, Math.sin(elevation)] };
}

/** 0 in full night, 1 in full day, smooth through civil twilight. */
export function daylight(secondsOfDay: number): number {
  const el = sunAt(secondsOfDay).elevation / DEG;
  const t = Math.max(0, Math.min(1, (el + 6) / 12));
  return t * t * (3 - 2 * t);
}

export function formatClock(secondsOfDay: number, withSeconds = false): string {
  const s = ((Math.floor(secondsOfDay) % 86400) + 86400) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return withSeconds ? `${hh}:${mm}:${String(s % 60).padStart(2, '0')}` : `${hh}:${mm}`;
}
