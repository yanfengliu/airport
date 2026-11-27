// The airside benchmark's judge of runway conflicts and of aircraft flying at each other, from
// positions alone: what tools/sim/soak.ts applies every step, kept apart from it so that cases can
// be put to it directly (test/conflicts.test.ts). The rule is set out in soak.ts's header.

import type { Layout } from '../../src/shared/layout.ts';
import { CONFIG } from '../../src/sim/config.ts';

/** What the judge needs to know of an aircraft: where it is, how high and fast, which way it faces (radians from east), and what it is doing. */
export interface Placed {
  id: number;
  x: number;
  y: number;
  alt: number;
  speed: number;
  heading: number;
  phase: string;
}

/** A runway's strip: from one end, the direction to the other, and its length. */
export interface Strip {
  id: string;
  x: number;
  y: number;
  ux: number;
  uy: number;
  length: number;
}

/** Half the width of a runway's strip, metres, and the conflict rule's numbers (see soak.ts's header). */
const STRIP = 45;
const FAST = 10;
const AHEAD = 1500;
const REACH_SECONDS = 20;
const REACH_LEAST = 300;
/** A departure ahead is out of the way once it is this far down the runway and this fast: the tower's own rule. */
const AWAY_ALONG = CONFIG.runway.departedAlongForLanding;
const AWAY = CONFIG.runway.departedSpeedForLanding;
/**
 * The height at which an arrival on the glide path crosses the landing threshold. An arrival
 * keeps its approach phase until its wheels touch; below this height it is over the runway, in
 * the flare, and the runway ahead of it must be clear as for a landing on its roll-out.
 */
export const THRESHOLD_HEIGHT = CONFIG.approach.touchdownBeyondThreshold * Math.tan(CONFIG.approach.glideSlope);

export function stripsOf(layout: Layout): Strip[] {
  return layout.airfield.runways.map((r) => {
    const [a, b] = r.ends;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    return { id: r.id, x: a.x, y: a.y, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length, length };
  });
}

/** Landing, in the flare over the runway, or taking off: on the runway at speed with the way ahead to keep clear. */
function rolling(a: Placed): boolean {
  return a.phase === 'landing' || a.phase === 'takeoff' || a.phase === 'climb' || (a.phase === 'approach' && a.alt <= THRESHOLD_HEIGHT);
}

/**
 * Pairs of aircraft in conflict on a runway now: `a` rolling fast with `b` on the strip ahead of
 * it within reach, neither airborne, `b` not taking off away from it fast. Keys `a:b` are added
 * to `found`; the first pair found, described, goes into `first` if it is empty.
 */
export function runwayConflicts<T extends Placed>(strips: readonly Strip[], list: readonly T[], found: Set<string>, describe: (a: T, b: T) => string, first: string[]): void {
  for (const s of strips) {
    const on: { a: T; along: number; v: number }[] = [];
    for (const a of list) {
      if (a.alt > 30 || a.phase === 'gone') continue;
      const dx = a.x - s.x;
      const dy = a.y - s.y;
      const along = dx * s.ux + dy * s.uy;
      const lateral = Math.abs(-dx * s.uy + dy * s.ux);
      if (lateral > STRIP || along < -60 || along > s.length + 60) continue;
      on.push({ a, along, v: a.speed * (Math.cos(a.heading) * s.ux + Math.sin(a.heading) * s.uy) });
    }
    for (const p of on) {
      // Landing in the flare or just off the ground counts: the runway ahead must be clear. Rolling
      // means landing or taking off, down to the end of the roll-out: a taxiway inside the strip
      // carries taxiing aircraft, which are not rolling.
      if (Math.abs(p.v) < FAST || !rolling(p.a)) continue;
      const sign = Math.sign(p.v);
      for (const q of on) {
        if (q === p || q.a.alt > 3) continue;
        const gap = (q.along - p.along) * sign;
        // Ahead within what it would cover in the next REACH_SECONDS, at least REACH_LEAST and at
        // most AHEAD: a roll just starting is half a minute from an intersection a kilometre off.
        if (gap <= 0 || gap > Math.min(AHEAD, Math.max(REACH_LEAST, Math.abs(p.v) * REACH_SECONDS))) continue;
        // A departure taking off the same way, far enough down the runway and fast: out of the way,
        // as the tower judges it. Only a departure: a landing ahead is in the way whatever its speed.
        const down = sign > 0 ? q.along : s.length - q.along;
        if ((q.a.phase === 'takeoff' || q.a.phase === 'climb') && q.v * sign > AWAY && down > AWAY_ALONG) continue;
        const key = `${p.a.id}:${q.a.id}`;
        if (!found.has(key) && !first.length) first.push(`runway ${s.id}: ${describe(p.a, q.a)}`);
        found.add(key);
      }
    }
  }
}

/** Pairs of aircraft in the air near the field flying at each other along one line, as in tools/sim/scenario.ts. */
export function headOnInAir(list: readonly Placed[], found: Set<string>): void {
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.alt <= 3 || a.phase === 'gone') continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (b.alt <= 3 || b.phase === 'gone') continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 6000 || Math.abs(a.alt - b.alt) > 450) continue;
      const turn = Math.abs(Math.atan2(Math.sin(a.heading - b.heading), Math.cos(a.heading - b.heading)));
      const ux = Math.cos(a.heading);
      const uy = Math.sin(a.heading);
      const across = Math.abs(-(b.x - a.x) * uy + (b.y - a.y) * ux);
      const ahead = (b.x - a.x) * ux + (b.y - a.y) * uy;
      if (turn > 2.6 && across < 400 && ahead > 0) found.add(`${a.id}:${b.id}`);
    }
  }
}
