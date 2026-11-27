// Picking an aircraft under the pointer, and what the inspector says about it.

import * as THREE from 'three';
import { formatClock } from '../shared/sun.ts';
import type { Aircraft } from '../sim/airside/aircraft.ts';
import { NOT_YET } from '../sim/airside/flights.ts';
import { AIRCRAFT, AIRLINE_BY_CODE, DESTINATIONS } from '../sim/fleet.ts';
import { DAY } from '../sim/schedule.ts';
import type { Sim } from '../sim/sim.ts';
import type { InspectorInfo } from '../ui/inspector.ts';

/** How far from the pointer, in CSS pixels, an aircraft's middle may be and still be picked. */
const PICK_RADIUS = 28;

const scratch = new THREE.Vector3();

/** The aircraft whose middle is nearest the pointer on screen, within reach; null if none is. */
export function pickAircraft(sim: Sim, camera: THREE.Camera, canvas: HTMLCanvasElement, clientX: number, clientY: number): Aircraft | null {
  const box = canvas.getBoundingClientRect();
  let best: Aircraft | null = null;
  let bestDistance = PICK_RADIUS;
  for (const a of sim.airside.aircraft) {
    if (a.phase === 'gone') continue;
    scratch.set(a.x, a.alt + 2, -a.y).project(camera);
    if (scratch.z < -1 || scratch.z > 1) continue;
    const x = box.left + ((scratch.x + 1) / 2) * box.width;
    const y = box.top + ((1 - scratch.y) / 2) * box.height;
    // Big aircraft seen close can be picked anywhere along their body.
    const d = Math.hypot(x - clientX, y - clientY);
    if (d < bestDistance) {
      bestDistance = d;
      best = a;
    }
  }
  return best;
}

const PHASES: Record<string, string> = {
  approach: 'On approach',
  goAround: 'Going around',
  landing: 'Landing',
  taxiIn: 'Taxiing to the gate',
  parked: 'At the gate',
  pushback: 'Pushing back',
  starting: 'Starting engines',
  taxiOut: 'Taxiing out',
  lineUp: 'Lined up',
  takeoff: 'Taking off',
  climb: 'Climbing out',
};

const clock = (t: number): string => (t >= 0 ? formatClock(((t % DAY) + DAY) % DAY) : '—');

export function describeAircraft(sim: Sim, a: Aircraft, following: boolean): InspectorInfo {
  const v = a.visit;
  const r = v.rotation;
  const airline = AIRLINE_BY_CODE[r.airline];
  const type = AIRCRAFT[r.type];
  const from = DESTINATIONS[r.from];
  const to = DESTINATIONS[r.to];
  // Once its passengers are off at the gate, an aircraft is known by the flight it leaves as.
  const departing = a.phase === 'pushback' || a.phase === 'starting' || a.phase === 'taxiOut' || a.phase === 'lineUp' || a.phase === 'takeoff' || a.phase === 'climb' || (a.phase === 'parked' && v.deplaned >= r.paxIn);
  let doing = PHASES[a.phase] ?? a.phase;
  if (a.phase === 'parked') doing = v.doorsClosed ? 'Doors closed, waiting to push back' : v.boardingOpen ? 'Boarding' : v.deplaned < r.paxIn ? 'Passengers getting off' : 'Turning round';
  if (a.waitingSince >= 0 && a.holdKind && a.phase !== 'parked') doing += `, holding (${a.holdKind})`;
  const rows: [string, string][] = [
    ['Now', doing],
    ['Gate', v.stand || '—'],
    ['Runway', (departing ? v.departureRunway : v.arrivalRunway) || a.runwayEnd || '—'],
    ['Arrival', `${r.arrFlight} from ${from.city}: due ${clock(v.sta)}, ${v.onBlockAt !== NOT_YET ? `on stand ${clock(v.onBlockAt)}` : `expected ${clock(Math.max(v.eta, v.queuedEta))}`}`],
    ['Departure', `${r.depFlight} to ${to.city}: due ${clock(v.std)}, ${v.offBlockAt !== NOT_YET ? `off stand ${clock(v.offBlockAt)}` : `expected ${clock(v.etd)}`}`],
    ['Passengers', `${Math.round(v.deplaned)} of ${r.paxIn} off, ${Math.round(v.boarded)} of ${r.paxOut} on`],
    ['Speed', a.speed > 0.5 ? `${Math.round(a.speed * 1.944)} kt${a.alt > 3 ? `, ${Math.round(a.alt * 3.281).toLocaleString('en-US')} ft` : ''}` : 'Standing'],
  ];
  if (v.delayNote) rows.push(['Delay', v.delayNote]);
  if (v.goArounds) rows.push(['Go-arounds', String(v.goArounds)]);
  return { title: `${airline?.name ?? r.airline} ${departing ? r.depFlight : r.arrFlight}`, subtitle: `${type.name} · ${r.tail}`, rows, following };
}
