// The operations panel: how the airport is running and what it is set up for, with the controls
// an operations centre has over it: the weather it is run for, and which runways and security
// checkpoints are open. It shows a snapshot (src/app/ops-source.ts) and calls back for changes.

import { formatClock } from '../shared/sun.ts';
import { el, setText } from './dom.ts';

/** Everything the panel shows, as plain numbers and words. */
export interface OpsSnapshot {
  plan: string;
  landing: string[];
  departing: string[];
  longDepartures: string[];
  paired: boolean;
  /** Seconds left of a change of runways, 0 when none is under way. */
  changeover: number;
  runways: { id: string; closed: boolean }[];
  weather: { windFrom: number; windKnots: number; visibility: number; ceiling: number; tailwind28: number };
  /** Landings and take-offs an hour, recently; delays in seconds; aircraft in each state now. */
  movements: { arrivals: number; departures: number; goArounds: number; arrivalDelay: number; departureDelay: number; approaching: number; taxiing: number; waitingToLand: number; queuedForTakeoff: number };
  gates: { occupied: number; usable: number };
  /** Each checkpoint: lanes open of all, people waiting, and the recent wait in seconds. */
  checkpoints: { id: number; name: string; open: number; lanes: number; line: number; wait: number; closed: boolean }[];
  bags: { inSystem: number; onBelts: number; mishandled: number };
  crews: { fuel: number; inspection: number; cleaning: number; queued: number };
  concessions: { open: number; outlets: number; soldOut: number; unitsSold: number; deliveries: number; revenue: number } | null;
  curbs: { dropOff: number; pickUp: number } | null;
  roads: { name: string; mph: number; vehicles: number }[];
  vehicles: number;
  people: number;
  events: { time: number; kind: string; text: string }[];
}

export interface OpsActions {
  setWeather(id: string): void;
  setRunwayClosed(id: string, closed: boolean): void;
  setCheckpointClosed(id: number, closed: boolean): void;
}

export interface OpsPanel {
  root: HTMLElement;
  update(snapshot: OpsSnapshot, weatherId: string): void;
  /** Show a short message, such as why a checkpoint could not be closed. */
  notice(text: string): void;
}

const minutes = (seconds: number): string => `${Math.round(seconds / 60)} min`;

function section(title: string, children: HTMLElement[]): HTMLElement {
  return el('section', { class: 'ops-section' }, [el('h3', { text: title }), ...children]);
}

/** A row of label and value cells that can be filled by key. */
function stats(keys: [string, string][]): { node: HTMLElement; set(key: string, value: string, tone?: string): void } {
  const values = new Map<string, HTMLElement>();
  const node = el(
    'dl',
    { class: 'ops-stats' },
    keys.flatMap(([key, label]) => {
      const value = el('dd', { attrs: { 'data-stat': key } });
      values.set(key, value);
      return [el('dt', { text: label }), value];
    }),
  );
  return {
    node,
    set(key, value, tone) {
      const cell = values.get(key)!;
      setText(cell, value);
      if (tone) cell.dataset.tone = tone;
      else delete cell.dataset.tone;
    },
  };
}

export function createOpsPanel(presets: readonly { id: string; label: string }[], actions: OpsActions): OpsPanel {
  // ---- runways and weather ----------------------------------------------------------------
  const plan = el('div', { class: 'ops-plan' });
  const planDetail = el('div', { class: 'ops-dim' });
  const runwayButtons = new Map<string, HTMLButtonElement>();
  const runwayRow = el('div', { class: 'ops-chips', attrs: { role: 'group', 'aria-label': 'Runways' } });
  const weatherButtons = presets.map((p) =>
    el('button', { class: 'chip', text: p.label, title: `Run the airport for: ${p.label}`, attrs: { type: 'button', 'data-weather': p.id }, on: { click: () => actions.setWeather(p.id) } }),
  );
  const weatherLine = el('div', { class: 'ops-dim' });
  // ---- movements, gates, security, bags, roads ---------------------------------------------
  const moves = stats([
    ['arrivals', 'Landings an hour'],
    ['departures', 'Take-offs an hour'],
    ['arrivalDelay', 'Landing delay'],
    ['departureDelay', 'Push-back delay'],
    ['approaching', 'On approach'],
    ['waitingToLand', 'Waiting to land'],
    ['taxiing', 'Taxiing'],
    ['queued', 'Queued to take off'],
    ['goArounds', 'Go-arounds today'],
    ['gates', 'Gates in use'],
  ]);
  const security = el('div', { class: 'ops-table', attrs: { role: 'table', 'aria-label': 'Security checkpoints' } });
  const securityRows = new Map<number, { row: HTMLElement; lanes: HTMLElement; wait: HTMLElement; line: HTMLElement; button: HTMLButtonElement }>();
  const bags = stats([
    ['inSystem', 'Checked bags on their way'],
    ['onBelts', 'Bags on the claim belts'],
    ['mishandled', 'Mishandled today'],
  ]);
  const crews = stats([['fuel', 'Stands refuelling'], ['inspection', 'Aircraft in inspection'], ['cleaning', 'Cabins being cleaned'], ['crewQueue', 'Jobs awaiting a crew']]);
  const retail = stats([['open', 'Staffed outlets'], ['soldOut', 'Out of stock'], ['sales', 'Items sold'], ['takings', 'Takings'], ['loads', 'Concourse deliveries']]);
  const roads = stats([
    ['curbFlow', 'Curb demand per hour'],
    ['US-101', 'US-101'],
    ['I-380', 'I-380'],
    ['Airport spur', 'Airport spur'],
    ['Terminal loop', 'Terminal loop'],
    ['vehicles', 'Vehicles on the map'],
    ['people', 'People in the terminals'],
  ]);
  const log = el('ol', { class: 'ops-log', attrs: { 'aria-label': 'Event log', 'aria-live': 'polite' } });
  const notice = el('div', { class: 'ops-notice', attrs: { role: 'status' } });

  const root = el('aside', { class: 'panel ops', attrs: { 'aria-label': 'Operations' } }, [
    el('h2', { text: 'Operations' }),
    notice,
    section('Runways', [plan, planDetail, runwayRow]),
    section('Weather', [el('div', { class: 'ops-chips' }, weatherButtons), weatherLine]),
    section('Movements', [moves.node]),
    section('Ground handling', [crews.node]),
    section('Security', [security]),
    section('Bags', [bags.node]),
    section('Concessions', [retail.node]),
    section('Roads', [roads.node]),
    section('Log', [log]),
  ]);

  let noticeUntil = 0;
  const logItems: HTMLElement[] = [];

  function update(s: OpsSnapshot, weatherId: string): void {
    setText(plan, `${s.plan} Plan${s.changeover > 0 ? ` — changing over, ${minutes(s.changeover)} to go` : ''}`);
    setText(planDetail, `Landing ${s.landing.join(' and ') || 'nothing'}${s.paired ? ' side by side' : ', one stream'} · taking off ${s.departing.join(' and ')} · long-haul ${s.longDepartures.join(' and ')}`);
    for (const r of s.runways) {
      let button = runwayButtons.get(r.id);
      if (!button) {
        const id = r.id;
        button = el('button', { class: 'chip', attrs: { type: 'button', 'data-runway': id }, on: { click: () => actions.setRunwayClosed(id, !button!.classList.contains('closed')) } });
        runwayButtons.set(id, button);
        runwayRow.append(button);
      }
      setText(button, `${r.id} ${r.closed ? 'closed' : 'open'}`);
      button.title = r.closed ? `Open runway ${r.id} again` : `Close runway ${r.id} to new traffic`;
      button.classList.toggle('closed', r.closed);
    }
    for (const b of weatherButtons) b.classList.toggle('on', b.dataset.weather === weatherId);
    const w = s.weather;
    setText(weatherLine, `Wind ${String(Math.round(w.windFrom)).padStart(3, '0')}° ${Math.round(w.windKnots)} kt (${w.tailwind28 > 0 ? `${Math.round(w.tailwind28)} kt tailwind` : `${Math.round(-w.tailwind28)} kt headwind`} on 28) · visibility ${w.visibility} mi · cloud ${w.ceiling >= 12_000 ? 'high' : `${w.ceiling.toLocaleString('en-US')} ft`}`);

    const m = s.movements;
    moves.set('arrivals', String(Math.round(m.arrivals)));
    moves.set('departures', String(Math.round(m.departures)));
    moves.set('arrivalDelay', minutes(m.arrivalDelay), m.arrivalDelay > 900 ? 'bad' : m.arrivalDelay > 300 ? 'warn' : undefined);
    moves.set('departureDelay', minutes(m.departureDelay), m.departureDelay > 900 ? 'bad' : m.departureDelay > 300 ? 'warn' : undefined);
    moves.set('approaching', String(m.approaching));
    moves.set('waitingToLand', String(m.waitingToLand), m.waitingToLand > 10 ? 'warn' : undefined);
    moves.set('taxiing', String(m.taxiing));
    moves.set('queued', String(m.queuedForTakeoff), m.queuedForTakeoff > 10 ? 'warn' : undefined);
    moves.set('goArounds', String(m.goArounds));
    moves.set('gates', `${s.gates.occupied} of ${s.gates.usable}`);

    crews.set('fuel', String(s.crews.fuel));
    crews.set('inspection', String(s.crews.inspection));
    crews.set('cleaning', String(s.crews.cleaning));
    crews.set('crewQueue', String(s.crews.queued));
    const c = s.concessions;
    retail.set('open', c ? `${c.open} of ${c.outlets}` : '—');
    retail.set('soldOut', c ? String(c.soldOut) : '—');
    retail.set('sales', c ? c.unitsSold.toLocaleString('en-US') : '—');
    retail.set('takings', c ? c.revenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—');
    retail.set('loads', c ? String(c.deliveries) : '—');
    roads.set('curbFlow', s.curbs ? `${Math.round(s.curbs.dropOff)} drop-off · ${Math.round(s.curbs.pickUp)} pickup` : '—');

    for (const c of s.checkpoints) {
      let row = securityRows.get(c.id);
      if (!row) {
        const id = c.id;
        const button = el('button', { class: 'chip ghost small', attrs: { type: 'button', 'data-checkpoint': String(id) }, on: { click: () => actions.setCheckpointClosed(id, !button.classList.contains('closed')) } });
        const cells = { lanes: el('span', { class: 'num' }), wait: el('span', { class: 'num' }), line: el('span', { class: 'num' }) };
        row = { row: el('div', { class: 'ops-row', attrs: { role: 'row' } }, [el('span', { class: 'name', text: c.name }), cells.lanes, cells.line, cells.wait, button]), ...cells, button };
        securityRows.set(id, row);
        security.append(row.row);
      }
      setText(row.lanes, `${c.open}/${c.lanes} lanes`);
      setText(row.line, `${c.line} waiting`);
      setText(row.wait, `~${minutes(c.wait)}`);
      row.wait.dataset.tone = c.wait > 1500 ? 'bad' : c.wait > 900 ? 'warn' : '';
      setText(row.button, c.closed ? 'Open' : 'Close');
      row.button.title = c.closed ? `Open ${c.name} again` : `Close ${c.name}: its travellers go to the next checkpoint`;
      row.button.classList.toggle('closed', c.closed);
      row.row.classList.toggle('closed', c.closed);
    }

    bags.set('inSystem', s.bags.inSystem.toLocaleString('en-US'));
    bags.set('onBelts', s.bags.onBelts.toLocaleString('en-US'));
    bags.set('mishandled', `${(s.bags.mishandled * 100).toFixed(2)}%`, s.bags.mishandled > 0.01 ? 'bad' : undefined);
    for (const r of s.roads) roads.set(r.name, r.vehicles ? `${Math.round(r.mph)} mph` : '—', r.vehicles && r.mph < 25 && r.name !== 'Terminal loop' ? 'warn' : undefined);
    roads.set('vehicles', s.vehicles.toLocaleString('en-US'));
    roads.set('people', s.people.toLocaleString('en-US'));

    s.events.forEach((e, i) => {
      let item = logItems[i];
      if (!item) {
        item = el('li', {}, [el('time'), el('span')]);
        logItems.push(item);
        log.append(item);
      }
      setText(item.firstElementChild as HTMLElement, formatClock(e.time));
      setText(item.lastElementChild as HTMLElement, e.text);
      item.dataset.kind = e.kind;
    });
    for (let i = s.events.length; i < logItems.length; i += 1) logItems[i].remove();
    logItems.length = s.events.length;
    if (noticeUntil && performance.now() > noticeUntil) {
      setText(notice, '');
      noticeUntil = 0;
    }
  }

  return {
    root,
    update,
    notice(text: string): void {
      setText(notice, text);
      noticeUntil = performance.now() + 6000;
    },
  };
}
