// Which stands the simulation can actually use, for how big an aircraft, and which of them get in
// each other's way. An aircraft must be able to taxi to a stand from every landing runway and,
// once pushed back, reach every departure runway. A few mapped parking positions sit on lines that
// join the taxiways too sharply to follow, at the end of a taxilane too short to turn a long
// aircraft in, or on a lead-in shorter than the aircraft their width would admit.

import type { TaxiNet } from '../airfield/net.ts';
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

export interface LeadIn {
  /** Blocks from the stop point back to the first taxiway, and their length. */
  blocks: number[];
  length: number;
}

/** Each stand's own line: the shortest way along stand lines from its stop point to a taxiway. */
export function leadIns(net: TaxiNet): Map<string, LeadIn> {
  const result = new Map<string, LeadIn>();
  for (const [id, start] of net.standNode) {
    const best = new Map<number, { length: number; blocks: number[] }>([[start, { length: 0, blocks: [] }]]);
    const open = [start];
    let found: LeadIn | null = null;
    while (open.length) {
      open.sort((a, b) => best.get(a)!.length - best.get(b)!.length);
      const node = open.shift()!;
      const here = best.get(node)!;
      if (net.arcsFrom(node).some((arc) => net.arcBlock(arc).kind === 'twy')) {
        found = here;
        break;
      }
      for (const arc of net.arcsFrom(node)) {
        const block = net.arcBlock(arc);
        const to = net.arcTo(arc);
        if (block.kind !== 'stand' || net.nodes[to].stand) continue;
        const length = here.length + block.len;
        if (length >= (best.get(to)?.length ?? Infinity)) continue;
        best.set(to, { length, blocks: [...here.blocks, block.id] });
        if (!open.includes(to)) open.push(to);
      }
    }
    if (found) result.set(id, found);
  }
  return result;
}

export function standAccess(net: TaxiNet, arrivalEnds: readonly string[], departureEnds: readonly string[]): Map<string, StandAccess> {
  const access = new Map<string, StandAccess>();
  for (const id of net.stands.keys()) access.set(id, { from: [], to: SIZES.map(() => []) });

  for (const end of arrivalEnds) {
    const reached = net.reachableFrom(net.exits(end).map((exit) => exit.arc));
    for (const [id, node] of net.standNode) {
      // Arcs that arrive at the stop point are the reverses of the ones that leave it.
      if (net.arcsFrom(node).some((arc) => reached[arc ^ 1])) access.get(id)!.from.push(end);
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
  /** Stands that cannot be occupied together: they share a lead-in line, or are alternates. */
  conflicts: Map<string, string[]>;
}

export function usableStands(net: TaxiNet, arrivalEnds: readonly string[], departureEnds: readonly string[]): UsableStands {
  const span = new Map<string, number>();
  const lines = leadIns(net);
  for (const [id, a] of standAccess(net, arrivalEnds, departureEnds)) {
    const line = lines.get(id);
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
  for (const id of span.keys()) for (const block of lines.get(id)!.blocks) users.set(block, [...(users.get(block) ?? []), id]);
  const conflicts = new Map<string, string[]>();
  const add = (id: string, other: string): void => {
    if (other !== id && span.has(other) && !(conflicts.get(id) ?? []).includes(other)) conflicts.set(id, [...(conflicts.get(id) ?? []), other]);
  };
  for (const ids of users.values()) for (const id of ids) for (const other of ids) add(id, other);
  // Alternates: lines painted for the same ground, where even two small aircraft would touch.
  for (const id of span.keys()) for (const other of net.stands.get(id)!.alt ?? []) add(id, other);
  return { span, conflicts };
}
