// The heads-up display: clock and speed, quick jumps through the day, camera presets, credits.

import type { Preset } from '../app/presets.ts';
import { formatClock } from '../shared/sun.ts';
import { el, setText } from './dom.ts';

export const SPEEDS = [0, 1, 5, 15, 60] as const;

export const DAY_JUMPS: { id: string; label: string; seconds: number }[] = [
  { id: 'dawn', label: 'Dawn', seconds: 6.75 * 3600 },
  { id: 'day', label: 'Day', seconds: 12.5 * 3600 },
  { id: 'dusk', label: 'Dusk', seconds: 19 * 3600 },
  { id: 'night', label: 'Night', seconds: 22.5 * 3600 },
];

/** What the view shows of the terminals: their roofs, or one level inside them. */
export type Inside = 'off' | 'departures' | 'arrivals';
export const INSIDE: { id: Inside; label: string; title: string }[] = [
  { id: 'off', label: 'Roofs', title: 'Show the terminals from outside (I cycles)' },
  { id: 'departures', label: 'Departures', title: 'Lift the roofs: check-in, security, shops and gates (I cycles)' },
  { id: 'arrivals', label: 'Arrivals', title: 'Lift the roofs: baggage claim and the way out (I cycles)' },
];

/** Panels the top bar opens and closes, with the key that does the same. */
export type PanelId = 'flights' | 'ops';
export const PANELS: { id: PanelId; label: string; key: string; title: string }[] = [
  { id: 'flights', label: 'Flights', key: 'B', title: 'Departure and arrival boards (B)' },
  { id: 'ops', label: 'Operations', key: 'O', title: 'Runways, weather, delays, security, bags and roads (O)' },
];

export interface HudActions {
  setSpeed(speed: number): void;
  jumpTo(secondsOfDay: number): void;
  goToPreset(id: string): void;
  setInside(inside: Inside): void;
  togglePanel(id: PanelId): void;
}

export interface HudState {
  secondsOfDay: number;
  speed: number;
  fps: number;
  presetId: string | null;
  inside: Inside;
  panels: Record<PanelId, boolean>;
}

export interface Hud {
  update(state: HudState): void;
  setVisible(visible: boolean): void;
  readonly visible: boolean;
}

export function createHud(root: HTMLElement, presets: readonly Preset[], attribution: string, actions: HudActions): Hud {
  const clock = el('div', { class: 'clock', text: '--:--' });
  const phase = el('div', { class: 'phase', text: '' });

  const speedButtons = SPEEDS.map((speed) =>
    el('button', {
      class: 'chip',
      text: speed === 0 ? 'Pause' : `${speed}×`,
      title: speed === 0 ? 'Pause (Space)' : `Run at ${speed}× real time`,
      attrs: { 'data-speed': String(speed), type: 'button' },
      on: { click: () => actions.setSpeed(speed) },
    }),
  );
  const jumpButtons = DAY_JUMPS.map((jump) =>
    el('button', {
      class: 'chip ghost',
      text: jump.label,
      title: `Jump to ${formatClock(jump.seconds)}`,
      attrs: { 'data-jump': jump.id, type: 'button' },
      on: { click: () => actions.jumpTo(jump.seconds) },
    }),
  );
  const presetButtons = presets.map((preset, index) =>
    el('button', {
      class: 'chip',
      text: preset.label,
      title: `${preset.label} (key ${index + 1})`,
      attrs: { 'data-preset': preset.id, type: 'button' },
      on: { click: () => actions.goToPreset(preset.id) },
    }),
  );
  const insideButtons = INSIDE.map((option) =>
    el('button', {
      class: 'chip ghost',
      text: option.label,
      title: option.title,
      attrs: { 'data-inside': option.id, type: 'button' },
      on: { click: () => actions.setInside(option.id) },
    }),
  );
  const panelButtons = PANELS.map((panel) =>
    el('button', {
      class: 'chip ghost',
      text: panel.label,
      title: panel.title,
      attrs: { 'data-panel': panel.id, type: 'button' },
      on: { click: () => actions.togglePanel(panel.id) },
    }),
  );
  const fps = el('span', { class: 'fps', text: '' });

  const top = el('div', { class: 'bar top' }, [
    el('div', { class: 'brand' }, [el('span', { class: 'brand-code', text: 'SFO' }), el('span', { class: 'brand-name', text: 'San Francisco International' })]),
    el('div', { class: 'group' }, [clock, phase]),
    el('div', { class: 'group', attrs: { role: 'group', 'aria-label': 'Simulation speed' } }, speedButtons),
    el('div', { class: 'group', attrs: { role: 'group', 'aria-label': 'Time of day' } }, jumpButtons),
    el('div', { class: 'group', attrs: { role: 'group', 'aria-label': 'Inside the terminals' } }, insideButtons),
    el('div', { class: 'group', attrs: { role: 'group', 'aria-label': 'Panels' } }, panelButtons),
  ]);
  const bottom = el('div', { class: 'bar bottom' }, [el('div', { class: 'group wrap', attrs: { role: 'group', 'aria-label': 'Camera views' } }, presetButtons)]);
  const credit = el('div', { class: 'credit' }, [fps, el('span', { text: attribution })]);
  root.append(top, bottom, credit);

  let shownSpeed = -1;
  let shownPreset: string | null | undefined;
  let shownInside: Inside | undefined;
  return {
    update(state: HudState): void {
      setText(clock, formatClock(state.secondsOfDay, true));
      const hour = state.secondsOfDay / 3600;
      setText(phase, hour < 5.5 ? 'Night' : hour < 7.5 ? 'Dawn' : hour < 18 ? 'Day' : hour < 20 ? 'Dusk' : 'Night');
      setText(fps, `${Math.round(state.fps)} fps`);
      if (state.speed !== shownSpeed) {
        shownSpeed = state.speed;
        for (const button of speedButtons) button.classList.toggle('on', Number(button.dataset.speed) === state.speed);
      }
      if (state.presetId !== shownPreset) {
        shownPreset = state.presetId;
        for (const button of presetButtons) button.classList.toggle('on', button.dataset.preset === state.presetId);
      }
      if (state.inside !== shownInside) {
        shownInside = state.inside;
        for (const button of insideButtons) button.classList.toggle('on', button.dataset.inside === state.inside);
      }
      for (const button of panelButtons) button.classList.toggle('on', state.panels[button.dataset.panel as PanelId]);
    },
    setVisible(visible: boolean): void {
      // The map's credit stays on screen whatever else is hidden: the data's licence asks for it.
      root.classList.toggle('hud-hidden', !visible);
    },
    get visible(): boolean {
      return !root.classList.contains('hud-hidden');
    },
  };
}
