// A passenger floor plan. The same selection on the inset and in the directory locates the place
// in the 3D cut-away. Everything but the optional FlySFO reference works offline.
import type { IndoorFloor, PolygonData } from '../shared/layout.ts';
import { el } from './dom.ts';
import { PASSENGER_TERMINALS, type MapDestination, type PassengerMap } from './terminal-map-data.ts';
import './terminal-map.css';

const width = 340;
const height = 202;
const colours = { gate: '#ffcf79', business: '#76cbd0', service: '#c1ccdb' };
const ink = (p: MapDestination): string => p.group === 'Gates' ? colours.gate : ['Dining', 'Shops', 'Lounges'].includes(p.group) ? colours.business : colours.service;

export type MapLocation = { x: number; y: number; floor: IndoorFloor; distance: number };

export function createTerminalMap(maps: PassengerMap[], locate: (p: MapLocation) => void, close: () => void) {
  const terminal = el('select', { attrs: { 'aria-label': 'Passenger terminal' } }, PASSENGER_TERMINALS.map((t, i) => el('option', { text: t.name, attrs: { value: String(i) } })));
  const level = el('select', { attrs: { 'aria-label': 'Passenger floor' } }, ['Departures', 'Arrivals'].map((s) => el('option', { text: s, attrs: { value: s.toLowerCase() } })));
  const place = el('select', { attrs: { 'aria-label': 'Passenger destination' } });
  const drawing = el('canvas', { attrs: { role: 'img', 'aria-label': 'Passenger floor plan. Choose a destination from the list or click a point on the map.' } });
  const pdf = el('a', { text: 'Official terminal map (PDF) ↗', attrs: { target: '_blank', rel: 'noopener noreferrer' } });
  const root = el('aside', { class: 'panel terminal-map', attrs: { 'aria-label': 'Terminal map', hidden: '' } }, [
    el('div', { class: 'map-heading' }, [el('h2', { text: 'Terminal map' }), el('button', { class: 'chip ghost', text: 'Close', attrs: { type: 'button' }, on: { click: close } })]),
    terminal, level, drawing,
    el('div', { class: 'map-legend' }, ['Gates', 'Shops & dining', 'Services & art'].map((label, i) => el('span', { text: label, attrs: { style: '--dot:' + Object.values(colours)[i] } }))),
    el('label', { class: 'map-field' }, ['Destination', place]), pdf,
  ]);
  let visible: MapDestination[] = [];
  let points: { p: MapDestination; x: number; y: number }[] = [];
  let bounds = { x: 0, y: 0, spanX: 1, spanY: 1 };
  const floor = (): IndoorFloor => level.value === 'arrivals' ? 'arrivals' : 'departures';
  const selected = (): MapDestination | undefined => visible[Number(place.value)];
  const show = (): void => {
    const dest = selected();
    locate({ x: dest?.x ?? bounds.x, y: dest?.y ?? bounds.y, floor: floor(), distance: dest ? 62 : Math.max(bounds.spanY, bounds.spanX * 0.85) * 1.65 });
  };
  function draw(): void {
    const ratio = window.devicePixelRatio || 1;
    drawing.width = Math.ceil(width * ratio);
    drawing.height = Math.ceil(height * ratio);
    const ctx = drawing.getContext('2d');
    if (!ctx) return;
    ctx.scale(drawing.width / width, drawing.height / height);
    const scale = Math.min((width - 36) / bounds.spanX, (height - 30) / bounds.spanY);
    const project = (x: number, y: number) => ({ x: width / 2 + (x - bounds.x) * scale, y: height / 2 - (y - bounds.y) * scale });
    const polygon = (p: PolygonData, fill: string, stroke: string): void => {
      ctx.beginPath();
      for (const ring of [p.outer, ...(p.holes ?? [])]) {
        for (let i = 0; i < ring.length; i += 2) {
          const at = project(ring[i], ring[i + 1]);
          if (i === 0) ctx.moveTo(at.x, at.y);
          else ctx.lineTo(at.x, at.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = fill;
      ctx.fill('evenodd');
      ctx.strokeStyle = stroke;
      ctx.stroke();
    };
    const map = maps[Number(terminal.value)];
    for (const outline of map.outline) polygon(outline, '#283544', '#52647a');
    for (const p of visible) if (p.room) polygon(p.room, '#334455', '#546477');
    points = visible.map((p) => ({ p, ...project(p.x, p.y) }));
    const labelBoxes: { x: number; y: number }[] = [];
    ctx.textBaseline = 'middle';
    ctx.font = '500 9px system-ui';
    for (const { p, x, y } of points) {
      ctx.fillStyle = ink(p);
      ctx.beginPath();
      ctx.arc(x, y, p.group === 'Gates' ? 2.1 : 1.5, 0, 2 * Math.PI);
      ctx.fill();
      if (p.group === 'Gates' && labelBoxes.every((q) => Math.abs(q.x - x) > 22 || Math.abs(q.y - y) > 11)) {
        const labelX = x > width - 30 ? x - 22 : x + 4;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#15202c';
        ctx.strokeText(p.name.replace('Gate ', ''), labelX, y);
        ctx.fillText(p.name.replace('Gate ', ''), labelX, y);
        ctx.lineWidth = 1;
        labelBoxes.push({ x, y });
      }
    }
    const dest = selected();
    if (dest) {
      const { x, y } = project(dest.x, dest.y);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, 2 * Math.PI);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = '#c1ccdb';
    ctx.font = '10px system-ui';
    ctx.fillText('↑ N', 9, 13);
  }

  function populate(): void {
    const index = Number(terminal.value);
    const map = maps[index];
    pdf.href = PASSENGER_TERMINALS[index].map;
    visible = map.destinations.filter((p) => p.floor === floor());
    place.replaceChildren(el('option', { text: 'Terminal overview', attrs: { value: '-1' } }));
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const [i, p] of visible.entries()) {
      let group = groups.get(p.group);
      if (!group) {
        group = el('optgroup', { attrs: { label: p.group } });
        groups.set(p.group, group);
        place.append(group);
      }
      group.append(el('option', { text: p.name, attrs: { value: String(i) } }));
    }
    const xs = visible.map((p) => p.x);
    const ys = visible.map((p) => p.y);
    for (const b of map.outline) for (let i = 0; i < b.outer.length; i += 2) { xs.push(b.outer[i]); ys.push(b.outer[i + 1]); }
    const west = Math.min(...xs), east = Math.max(...xs), north = Math.max(...ys), south = Math.min(...ys);
    bounds = { x: (west + east) / 2, y: (north + south) / 2, spanX: Math.max(1, east - west), spanY: Math.max(1, north - south) };
    draw();
    show();
  }

  terminal.addEventListener('change', populate);
  level.addEventListener('change', populate);
  place.addEventListener('change', () => { draw(); show(); });
  drawing.addEventListener('click', (event) => {
    const rect = drawing.getBoundingClientRect();
    const x = (event.clientX - rect.left) * width / rect.width;
    const y = (event.clientY - rect.top) * height / rect.height;
    let nearest = -1;
    let best = 9;
    points.forEach((q, i) => {
      const distance = Math.hypot(x - q.x, y - q.y);
      if (distance < best) { best = distance; nearest = i; }
    });
    if (nearest < 0) return;
    place.value = String(nearest);
    draw();
    show();
  });
  // Native keyboard selection owns arrows, space, and type-to-find while a select has focus.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && (e.target instanceof HTMLSelectElement || e.key === ' ')) e.stopPropagation();
  });
  return { root, open(current: IndoorFloor) { level.value = current; populate(); } };
}
