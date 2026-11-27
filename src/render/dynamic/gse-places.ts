// Where the ground equipment stands round a parked aircraft, as its turnaround goes: power at the
// nose while it is on stand, belt loaders and baggage carts at the holds until the doors close,
// catering at the rear door before boarding, fuel at the wing, stairs at a remote stand, and the
// tug that pushes it back. Worked out from the aircraft and its visit; nothing here is simulated,
// and nothing here needs three.js, so the placement can be checked without drawing it.

import { wingOver } from '../../shared/airframe.ts';
import type { Aircraft } from '../../sim/airside/aircraft.ts';
import type { GseKind } from '../models/gse-parts.ts';

/** Seconds after reaching the stand that the fuel truck arrives, and before departure that it leaves. */
const FUEL_FROM = 600;
const FUEL_UNTIL = 900;
/** Sizes of the trucks as src/render/models/gse-parts.ts makes them, metres: how far out the catering truck reaches from the fuselage, its half width; the fuel truck's half width, half length and height. */
const CATERING_REACH = 7;
const CATERING_HALF_WIDTH = 1.25;
const FUEL_HALF_WIDTH = 1.2;
const FUEL_HALF_LENGTH = 4.6;
const FUEL_TOP = 3.05;

/** One piece of equipment: `along` metres from the middle of the aircraft towards its nose, `side` to its left, and `turn` its heading from the aircraft's. */
export interface GsePlace {
  kind: GseKind;
  along: number;
  side: number;
  turn: number;
}

/** What the placement needs to know of an aircraft and its visit. */
export interface Served {
  phase: Aircraft['phase'];
  type: Aircraft['type'];
  visit: Pick<Aircraft['visit'], 'onBlockAt' | 'etd' | 'doorsClosed' | 'deplaned' | 'boardingOpen'> & { rotation: Pick<Aircraft['visit']['rotation'], 'paxIn'> };
}

/** The equipment round an aircraft at `now`, added to `out`; `remote` when its stand has no jet bridge. */
export function gseAround(a: Served, now: number, remote: boolean, out: GsePlace[] = []): GsePlace[] {
  if (a.phase !== 'parked' && a.phase !== 'pushback' && a.phase !== 'starting') return out;
  const length = a.type.length;
  const half = a.type.fuselage / 2;
  const wide = a.type.body === 'wide' || a.type.body === 'super';
  const put = (kind: GseKind, along: number, side: number, turn: number): void => {
    out.push({ kind, along, side, turn });
  };
  if (a.phase !== 'parked') {
    // The tug at the nose gear, facing the way the aircraft faces, its tow bar reaching back.
    put('pushback', length / 2 - 0.12 * length + 4.8, 0, 0);
    return out;
  }
  const v = a.visit;
  const onStand = now - v.onBlockAt;
  // Ground power at the nose, on the right.
  put('power', length / 2 - 3, -(half + 2.5), 0);
  if (!v.doorsClosed) {
    // Bags out of the holds and back in, on the right: a belt loader square to the fuselage with
    // its high end at the door, and a train of carts beside it.
    put('loader', -0.27 * length, -(half + 4.3), Math.PI / 2);
    put('carts', -0.27 * length - 2, -(half + 10.5), 0);
    if (wide) {
      put('loader', 0.22 * length, -(half + 4.3), Math.PI / 2);
      put('carts', 0.22 * length + 2, -(half + 10.5), 0);
    }
  }
  // Catering after the passengers are off and before boarding, at the right rear door: behind
  // the wing, whose trailing edge sweeps back further the further out it is.
  if (v.deplaned >= v.rotation.paxIn && !v.boardingOpen && !v.doorsClosed) {
    const wing = wingOver(a.type, half + CATERING_REACH);
    const along = Math.min(-0.36 * length, wing ? wing.trail - CATERING_HALF_WIDTH - 0.8 : Infinity);
    put('catering', along, -(half + 4.3), -Math.PI / 2);
  }
  // Fuel under the right wing for most of the stay, where the wing is high enough to clear the
  // truck; under a low wing, just ahead of its leading edge instead: behind it the bags are
  // worked and the catering truck stands.
  if (onStand > FUEL_FROM && v.etd - now > FUEL_UNTIL) {
    const side = a.type.span * 0.26 + 1;
    const inner = wingOver(a.type, side - FUEL_HALF_WIDTH);
    const outer = wingOver(a.type, side + FUEL_HALF_WIDTH);
    const under = Math.min(inner?.under ?? Infinity, outer?.under ?? Infinity);
    // The leading edge sweeps back, so it is furthest forward on the inner side of the truck.
    const lead = Math.max(inner?.lead ?? -Infinity, outer?.lead ?? -Infinity);
    if (under > FUEL_TOP + 0.3) put('fuel', -0.04 * length, -side, 0);
    else put('fuel', lead + FUEL_HALF_LENGTH + 1, -side, 0);
  }
  // At a remote stand people come and go by stairs at the front left door.
  if (remote) put('stairs', length / 2 - 0.16 * length, half + 5.2, -Math.PI / 2);
  return out;
}
