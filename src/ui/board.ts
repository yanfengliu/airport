// The flight board: departures and arrivals as an airport screen shows them.

import type { BoardRow } from '../sim/airside/flights.ts';
import { formatClock } from '../shared/sun.ts';
import { el, setText } from './dom.ts';

export interface BoardSource {
  departures(limit: number): BoardRow[];
  arrivals(limit: number): BoardRow[];
  airlineName(code: string): string;
}

export interface Board {
  root: HTMLElement;
  /** Redraw from the simulation. Cheap enough to call once a second. */
  refresh(): void;
}

const ROWS = 16;

export function createBoard(source: BoardSource, onPick: (visit: number) => void): Board {
  let tab: 'departures' | 'arrivals' = 'departures';
  const tabs = (['departures', 'arrivals'] as const).map((id) =>
    el('button', {
      class: 'tab',
      text: id === 'departures' ? 'Departures' : 'Arrivals',
      attrs: { type: 'button', 'data-tab': id, role: 'tab' },
      on: {
        click: () => {
          tab = id;
          refresh();
        },
      },
    }),
  );
  const head = el('div', { class: 'board-row board-head' }, [
    el('span', { text: 'Time' }),
    el('span', { text: 'Flight' }),
    el('span', { class: 'city-head', text: 'To' }),
    el('span', { text: 'Gate' }),
    el('span', { text: 'Status' }),
  ]);
  const rows: { row: HTMLElement; cells: HTMLElement[]; visit: number }[] = [];
  for (let i = 0; i < ROWS; i += 1) {
    const cells = [el('span', { class: 'time' }), el('span', { class: 'flight' }), el('span', { class: 'city' }), el('span', { class: 'gate' }), el('span', { class: 'status' })];
    const entry = { row: el('button', { class: 'board-row', attrs: { type: 'button' } }, cells), cells, visit: -1 };
    entry.row.addEventListener('click', () => {
      if (entry.visit >= 0) onPick(entry.visit);
    });
    rows.push(entry);
  }
  const root = el('section', { class: 'panel board', attrs: { 'aria-label': 'Flight board' } }, [
    el('div', { class: 'tabs', attrs: { role: 'tablist' } }, tabs),
    head,
    el('div', { class: 'board-body' }, rows.map((r) => r.row)),
  ]);

  function refresh(): void {
    for (const t of tabs) t.classList.toggle('on', t.dataset.tab === tab);
    setText(head.querySelector('.city-head') as HTMLElement, tab === 'departures' ? 'To' : 'From');
    const data = tab === 'departures' ? source.departures(ROWS) : source.arrivals(ROWS);
    rows.forEach((entry, i) => {
      const item = data[i];
      entry.row.style.visibility = item ? 'visible' : 'hidden';
      if (!item) {
        entry.visit = -1;
        return;
      }
      entry.visit = item.visit;
      const changed = Math.abs(item.estimated - item.scheduled) >= 300;
      setText(entry.cells[0], changed ? `${formatClock(item.scheduled)} → ${formatClock(item.estimated)}` : formatClock(item.scheduled));
      setText(entry.cells[1], item.flight);
      setText(entry.cells[2], item.city);
      setText(entry.cells[3], item.gate);
      setText(entry.cells[4], item.status);
      entry.row.title = `${source.airlineName(item.airline)} ${item.flight}`;
      entry.row.dataset.tone = item.tone;
    });
  }

  refresh();
  return { root, refresh };
}
