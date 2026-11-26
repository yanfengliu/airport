// Which stands the simulation can actually use, for how big an aircraft, and which of them get in
// each other's way. An aircraft must be able to taxi to a stand from every landing runway and,
// once pushed back, reach every departure runway. A few mapped parking positions sit on lines that
// join the taxiways too sharply to follow, at the end of a taxilane too short to turn a long
// aircraft in, or on a line shorter than the aircraft their width would admit.

import { MAX_TURN, type StandLine, type TaxiNet } from '../airfield/net.ts';
import { NODE_CLEARANCE } from '../airfield/path.ts';
import { CONFIG } from '../config.ts';
import { pushbackOptions } from './pushback.ts';

export interface StandAccess {
  /** Runway ends an arrival can reach the stand from. */
  from: string[];
  /** Runway ends a departure can reach, for a body of each length in SIZES. */
  to: string[][];
}

/**
 * Aircraft sizes a stand is tried for: the longest fuselage of the class, metres, and the widest
 * wingspan the stand then counts as taking.
 */
export const SIZES: readonly { length: number; span: number }[] = [
  { length: 32, span: 29 },
  { length: 45, span: 36 },
  { length: 56, span: 52 },
  { length: 74, span: 80 },
];

/** Taxiway an aircraft of a length needs behind the junction it will leave by. */
export const pushRoom = (length: number): number => length + CONFIG.taxi.bodyMargin + 10;

/** Can an aircraft follow the line from its junction to the stop point without too sharp a turn? */
function followable(net: TaxiNet, line: StandLine): boolean {
  for (let i = 1; i < line.arcsIn.length; i += 1) if (net.turn(line.arcsIn[i - 1], line.arcsIn[i]) > MAX_TURN) return false;
  return line.arcsIn.length > 0;
}

export function standAccess(net: TaxiNet, arrivalEnds: readonly string[], departureEnds: readonly string[]): Map<string, StandAccess> {
  const access = new Map<string, StandAccess>();
  for (const id of net.stands.keys()) access.set(id, { from: [], to: SIZES.map(() => []) });

  for (const end of arrivalEnds) {
    const reached = net.reachableFrom(net.exits(end).map((exit) => exit.arc));
    for (const id of net.standNode.keys()) {
      const line = net.standLine(id);
      if (!line || !followable(net, line)) continue;
      // Some taxiway arc that a landing aircraft can come by must turn onto the line.
      const first = line.arcsIn[0];
      if (net.arcsFrom(line.junction).some((leaving) => reached[leaving ^ 1] && net.turn(leaving ^ 1, first) <= MAX_TURN)) access.get(id)!.from.push(end);
    }
  }

  const facing = new Map<string, number[][]>();
  for (const [id, node] of net.standNode) facing.set(id, SIZES.map((size) => pushbackOptions(net, node, pushRoom(size.length)).map((o) => o.forward)));
  for (const end of departureEnds) {
    const goals: number[] = [];
    for (const { node } of net.lineUpNodes(end)) for (const arc of net.arcsFrom(node)) if (net.arcBlock(arc).kind === 'twy') goals.push(arc ^ 1);
    const reaching = net.reaching(goals);
    for (const [id, bySize] of facing) {
      bySize.forEach((forwards, size) => {
        // The route has to go somewhere after the junction, so the facing arc alone is not enough.
        if (forwards.some((arc) => reaching[arc] && !goals.includes(arc))) access.get(id)!.to[size].push(end);
      });
    }
  }
  return access;
}

export interface UsableStands {
  /** Stands that work, with the widest wingspan each takes: its own, or less where a longer aircraft could not get out, or would not fit its line. */
  span: Map<string, number>;
  /** Stands that cannot be occupied together: they share a line, or are alternates. */
  conflicts: Map<string, string[]>;
}

export function usableStands(net: TaxiNet, arrivalEnds: readonly string[], departureEnds: readonly string[]): UsableStands {
  const span = new Map<string, number>();
  for (const [id, a] of standAccess(net, arrivalEnds, departureEnds)) {
    const line = net.standLine(id);
    if (!line || a.from.length < arrivalEnds.length) continue;
    let widest = 0;
    SIZES.forEach((size, index) => {
      // Parked, the whole aircraft has to be on its own line, its tail far enough from the
      // taxilane behind it for others to pass.
      const fits = line.length >= size.length + CONFIG.taxi.bodyMargin + NODE_CLEARANCE + 1;
      if (fits && a.to[index].length === departureEnds.length) widest = Math.max(widest, size.span);
    });
    if (widest > 0) span.set(id, Math.min(widest, net.stands.get(id)!.span));
  }
  const users = new Map<number, string[]>();
  for (const id of span.keys()) for (const block of net.standLine(id)!.blocks) users.set(block, [...(users.get(block) ?? []), id]);
  const conflicts = new Map<string, string[]>();
  const add = (id: string, other: string): void => {
    if (other !== id && span.has(other) && !(conflicts.get(id) ?? []).includes(other)) conflicts.set(id, [...(conflicts.get(id) ?? []), other]);
  };
  for (const ids of users.values()) for (const id of ids) for (const other of ids) add(id, other);
  // Alternates: lines painted for the same ground, where even two small aircraft would touch.
  for (const id of span.keys()) for (const other of net.stands.get(id)!.alt ?? []) add(id, other);
  return { span, conflicts };
}
