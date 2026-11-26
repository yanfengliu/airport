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

export interface HudActions {
  setSpeed(speed: number): void;
  jumpTo(secondsOfDay: number): void;
  goToPreset(id: string): void;
}

export interface HudState {
  secondsOfDay: number;
  speed: number;
  fps: number;
  presetId: string | null;
}

export interface Hud {
  update(state: HudState): void;
  setVisible(visible: boolean): void;
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
  const fps = el('span', { class: 'fps', text: '' });

  const top = el('div', { class: 'bar top' }, [
    el('div', { class: 'brand' }, [el('span', { class: 'brand-code', text: 'SFO' }), el('span', { class: 'brand-name', text: 'San Francisco International' })]),
    el('div', { class: 'group' }, [clock, phase]),
    el('div', { class: 'group', attrs: { role: 'group', 'aria-label': 'Simulation speed' } }, speedButtons),
    el('div', { class: 'group', attrs: { role: 'group', 'aria-label': 'Time of day' } }, jumpButtons),
  ]);
  const bottom = el('div', { class: 'bar bottom' }, [el('div', { class: 'group wrap', attrs: { role: 'group', 'aria-label': 'Camera views' } }, presetButtons)]);
  const credit = el('div', { class: 'credit' }, [fps, el('span', { text: attribution })]);
  root.append(top, bottom, credit);

  let shownSpeed = -1;
  let shownPreset: string | null | undefined;
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
    },
    setVisible(visible: boolean): void {
      root.style.display = visible ? '' : 'none';
    },
  };
}
