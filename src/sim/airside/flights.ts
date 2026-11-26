// The flight book: each day's instance of every scheduled visit, with its estimated and actual
// times and the status a flight board would show.

import { DESTINATIONS } from '../fleet.ts';
import { DAY, type Rotation } from '../schedule.ts';

export type VisitState = 'scheduled' | 'approach' | 'landed' | 'atStand' | 'pushback' | 'taxiOut' | 'airborne' | 'done';

export interface Visit {
  id: number;
  rotation: Rotation;
  /** Scheduled and estimated times at the stand, in simulation seconds from midnight of day 0. */
  sta: number;
  std: number;
  eta: number;
  etd: number;
  /** Actual times, once they have happened. */
  landedAt: number;
  onBlockAt: number;
  offBlockAt: number;
  airborneAt: number;
  stand: string;
  state: VisitState;
  arrivalRunway: string;
  departureRunway: string;
  /** Why the flight is late, when it is. */
  delayNote: string;
  aircraft: number;
  /** Passengers off and on so far, and whether doors are open for each. */
  deplaned: number;
  boarded: number;
  boardingOpen: boolean;
  doorsClosed: boolean;
  /** Go-arounds flown on this arrival. */
  goArounds: number;
}

/** Minutes a flight may run behind schedule before the board calls it delayed. */
const DELAY_SHOWN = 10 * 60;
/** Usual time from touchdown to the stand, used to aim landing times at scheduled gate times. */
export const TAXI_IN_NOMINAL = 7.5 * 60;

export interface BoardRow {
  visit: number;
  flight: string;
  airline: string;
  city: string;
  /** Scheduled and estimated time, seconds of the day. */
  scheduled: number;
  estimated: number;
  gate: string;
  status: string;
  tone: 'ok' | 'warn' | 'late' | 'done';
}

export class FlightBook {
  readonly visits = new Map<number, Visit>();
  private readonly rotations: readonly Rotation[];
  private builtThrough = -2;

  constructor(rotations: readonly Rotation[]) {
    this.rotations = rotations;
  }

  /** Make sure every visit that touches the time up to `until` exists. */
  extendTo(until: number): void {
    const lastDay = Math.floor(until / DAY);
    for (let day = this.builtThrough + 1; day <= lastDay; day += 1) {
      for (const rotation of this.rotations) {
        const sta = day * DAY + rotation.arr;
        const std = day * DAY + rotation.dep;
        const id = (day + 2) * 100_000 + rotation.id;
        this.visits.set(id, {
          id,
          rotation,
          sta,
          std,
          eta: sta,
          etd: std,
          landedAt: -1,
          onBlockAt: -1,
          offBlockAt: -1,
          airborneAt: -1,
          stand: rotation.stand,
          state: 'scheduled',
          arrivalRunway: '',
          departureRunway: '',
          delayNote: '',
          aircraft: -1,
          deplaned: 0,
          boarded: 0,
          boardingOpen: false,
          doorsClosed: false,
          goArounds: 0,
        });
      }
      this.builtThrough = day;
    }
  }

  /** Forget visits that ended long ago. */
  prune(now: number): void {
    for (const [id, v] of this.visits) if (v.state === 'done' && v.airborneAt >= 0 && now - v.airborneAt > 2 * 3600) this.visits.delete(id);
  }

  /** Visits already at their stands at `time`, for starting the simulation in mid-day. */
  parkedAt(time: number): Visit[] {
    return [...this.visits.values()].filter((v) => v.sta <= time - 60 && v.std > time).sort((a, b) => a.sta - b.sta);
  }

  /** Visits whose arrival has yet to start, soonest first. */
  inboundAfter(time: number): Visit[] {
    return [...this.visits.values()].filter((v) => v.state === 'scheduled' && v.sta > time - 60).sort((a, b) => a.sta - b.sta || a.id - b.id);
  }

  arrivalsBoard(now: number, limit: number): BoardRow[] {
    const rows: BoardRow[] = [];
    for (const v of this.visits.values()) {
      const shownUntil = v.onBlockAt >= 0 ? v.onBlockAt + 25 * 60 : Infinity;
      if (now > shownUntil || v.eta > now + 3 * 3600 || v.sta < now - 6 * 3600) continue;
      if (v.state === 'scheduled' && v.sta < now - 3600) continue;
      const late = v.eta - v.sta;
      let status = late > DELAY_SHOWN ? 'Delayed' : 'On time';
      let tone: BoardRow['tone'] = late > DELAY_SHOWN ? 'late' : 'ok';
      if (v.state === 'approach') status = v.goArounds ? 'Going around' : 'On approach';
      if (v.state === 'landed') status = 'Landed';
      if (v.onBlockAt >= 0) {
        status = v.deplaned < v.rotation.paxIn ? 'At gate' : 'Arrived';
        tone = 'done';
      }
      rows.push({ visit: v.id, flight: v.rotation.arrFlight, airline: v.rotation.airline, city: DESTINATIONS[v.rotation.from].city, scheduled: v.sta % DAY, estimated: (v.onBlockAt >= 0 ? v.onBlockAt : v.eta) % DAY, gate: v.stand, status, tone });
    }
    rows.sort((a, b) => this.visits.get(a.visit)!.eta - this.visits.get(b.visit)!.eta);
    return rows.slice(0, limit);
  }

  departuresBoard(now: number, limit: number): BoardRow[] {
    const rows: BoardRow[] = [];
    for (const v of this.visits.values()) {
      const shownUntil = v.airborneAt >= 0 ? v.airborneAt + 10 * 60 : Infinity;
      if (now > shownUntil || v.etd > now + 3 * 3600 || v.std < now - 6 * 3600) continue;
      const late = v.etd - v.std;
      let status = late > DELAY_SHOWN ? 'Delayed' : 'On time';
      let tone: BoardRow['tone'] = late > DELAY_SHOWN ? 'late' : 'ok';
      if (v.boardingOpen) {
        status = v.etd - now < 12 * 60 ? 'Final call' : 'Boarding';
        tone = 'warn';
      }
      if (v.doorsClosed) status = 'Gate closed';
      if (v.state === 'pushback' || v.state === 'taxiOut') status = 'Taxiing';
      if (v.airborneAt >= 0) {
        status = 'Departed';
        tone = 'done';
      }
      rows.push({ visit: v.id, flight: v.rotation.depFlight, airline: v.rotation.airline, city: DESTINATIONS[v.rotation.to].city, scheduled: v.std % DAY, estimated: (v.offBlockAt >= 0 ? v.offBlockAt : v.etd) % DAY, gate: v.stand, status, tone });
    }
    rows.sort((a, b) => this.visits.get(a.visit)!.etd - this.visits.get(b.visit)!.etd);
    return rows.slice(0, limit);
  }
}
