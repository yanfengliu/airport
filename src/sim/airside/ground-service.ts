// Each crew serves one stand at a time. Its next assignment includes the trip between stands.
import { CONFIG } from '../config.ts';
import { AIRCRAFT, DESTINATIONS } from '../fleet.ts';
import type { Rng } from '../rng.ts';
import type { Visit } from './flights.ts';

const cfg = CONFIG.groundService;
export const SERVICE_KINDS = ['fuel', 'inspection', 'cleaning'] as const;
export type ServiceKind = typeof SERVICE_KINDS[number];

export interface ServiceJob {
  status: 'waiting' | 'working' | 'done';
  requestedAt: number;
  startsAt: number;
  endsAt: number;
  duration: number;
  crew: number | null;
}

export interface Turnaround {
  jobs: Record<ServiceKind, ServiceJob>;
  fuelKg: number;
  fuelDeliveredKg: number;
  followup: boolean;
}

function job(requestedAt: number, duration: number): ServiceJob {
  return { requestedAt, duration, startsAt: Infinity, endsAt: Infinity, crew: null, status: 'waiting' };
}

function workFor(v: Visit, rng: Rng): Turnaround {
  const body = AIRCRAFT[v.rotation.type].body;
  const fuelKg = Math.round(cfg.localUpliftKg[body] + DESTINATIONS[v.rotation.to].km * cfg.kgPerKm[body]);
  const followup = rng.chance(cfg.followupShare);
  const inspection = cfg.inspectionSeconds[body] + (followup ? rng.range(...cfg.followupSeconds) : 0);
  return {
    jobs: {
      fuel: job(v.onBlockAt + cfg.fuelCallAfter, cfg.fuelSetup + fuelKg / cfg.pumpKgPerSecond[body]),
      inspection: job(v.onBlockAt + cfg.inspectionCallAfter, inspection),
      cleaning: job(Infinity, cfg.cleaningSetup + v.rotation.paxIn * cfg.cleaningSecondsPerPassenger[body]),
    },
    fuelKg, fuelDeliveredKg: 0, followup,
  };
}

interface Request {
  visit: number;
  work: ServiceJob;
}

export class GroundService {
  private readonly freeAt: Record<ServiceKind, number[]>;
  private readonly rng: Rng;

  constructor(rng: Rng, crews: Readonly<Record<ServiceKind, number>> = cfg.crews) {
    this.rng = rng;
    const slots = (n: number): number[] => Array(n).fill(-Infinity);
    this.freeAt = { fuel: slots(crews.fuel), inspection: slots(crews.inspection), cleaning: slots(crews.cleaning) };
  }

  /** For a mid-day start, reconstruct past assignments of the aircraft still on stand, in request order. */
  step(parked: readonly Visit[], now: number, starting = false): void {
    const pending: Record<ServiceKind, Request[]> = { fuel: [], inspection: [], cleaning: [] };
    for (const v of parked) {
      const s = v.service ??= workFor(v, this.rng.fork(String(v.id)));
      const cleaning = s.jobs.cleaning;
      if (starting && now - v.onBlockAt > cfg.prestartPassengersGoneAfter) {
        const type = AIRCRAFT[v.rotation.type];
        cleaning.requestedAt = v.onBlockAt + CONFIG.turnaround.bridgeOn[1] + v.rotation.paxIn / (0.45 * type.doors);
      } else if (!Number.isFinite(cleaning.requestedAt) && v.deplaned >= v.rotation.paxIn) {
        cleaning.requestedAt = now;
      }
      for (const kind of SERVICE_KINDS) {
        const work = s.jobs[kind];
        if (work.crew === null && work.requestedAt <= now) pending[kind].push({ visit: v.id, work });
      }
    }
    for (const kind of SERVICE_KINDS) {
      const slots = this.freeAt[kind];
      if (!slots.length) continue;
      pending[kind].sort((a, b) => a.work.requestedAt - b.work.requestedAt || a.visit - b.visit);
      for (const { work } of pending[kind]) {
        let crew = 0;
        for (let i = 1; i < slots.length; i++) if (slots[i] < slots[crew]) crew = i;
        work.crew = crew;
        work.startsAt = Math.max(work.requestedAt, slots[crew]);
        work.endsAt = work.startsAt + work.duration;
        slots[crew] = work.endsAt + cfg.transferSeconds[kind];
      }
    }
    for (const v of parked) {
      const s = v.service!;
      for (const kind of SERVICE_KINDS) {
        const w = s.jobs[kind];
        w.status = now >= w.endsAt ? 'done' : now >= w.startsAt ? 'working' : 'waiting';
      }
      const fuel = s.jobs.fuel;
      const seconds = Math.max(0, now - fuel.startsAt - cfg.fuelSetup);
      s.fuelDeliveredKg = fuel.status === 'done' ? s.fuelKg : Math.min(s.fuelKg, seconds * cfg.pumpKgPerSecond[AIRCRAFT[v.rotation.type].body]);
    }
  }
}
