// The inspector: a card about the aircraft picked on the map or the flight board, with a button
// to follow it with the camera.

import { el, setText } from './dom.ts';

export interface InspectorInfo {
  title: string;
  subtitle: string;
  rows: [string, string][];
  following: boolean;
}

export interface Inspector {
  root: HTMLElement;
  /** Fill the card, or hide it with null. */
  show(info: InspectorInfo | null): void;
}

export function createInspector(actions: { toggleFollow(): void; close(): void }): Inspector {
  const title = el('div', { class: 'inspect-title' });
  const subtitle = el('div', { class: 'ops-dim' });
  const table = el('dl', { class: 'ops-stats' });
  const follow = el('button', { class: 'chip', text: 'Follow', title: 'Keep the camera on this aircraft (F)', attrs: { type: 'button', 'data-action': 'follow' }, on: { click: () => actions.toggleFollow() } });
  const close = el('button', { class: 'chip ghost', text: 'Close', title: 'Close (Esc)', attrs: { type: 'button', 'data-action': 'close' }, on: { click: () => actions.close() } });
  const root = el('aside', { class: 'panel inspector', attrs: { 'aria-label': 'Aircraft' } }, [title, subtitle, table, el('div', { class: 'ops-chips' }, [follow, close])]);
  root.hidden = true;
  const cells: { dt: HTMLElement; dd: HTMLElement }[] = [];
  return {
    root,
    show(info) {
      root.hidden = info === null;
      if (!info) return;
      setText(title, info.title);
      setText(subtitle, info.subtitle);
      info.rows.forEach(([label, value], i) => {
        let cell = cells[i];
        if (!cell) {
          cell = { dt: el('dt'), dd: el('dd') };
          cells.push(cell);
          table.append(cell.dt, cell.dd);
        }
        setText(cell.dt, label);
        setText(cell.dd, value);
      });
      for (let i = info.rows.length; i < cells.length; i += 1) {
        cells[i].dt.remove();
        cells[i].dd.remove();
      }
      cells.length = info.rows.length;
      follow.classList.toggle('on', info.following);
      setText(follow, info.following ? 'Following' : 'Follow');
    },
  };
}
