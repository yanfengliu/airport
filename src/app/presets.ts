// Named camera views. The number keys 1 to 9 go to the first nine in this order.

import type { CameraView } from '../render/camera.ts';

export interface Preset {
  id: string;
  label: string;
  view: CameraView;
}

export const PRESETS: Preset[] = [
  { id: 'overview', label: 'Overview', view: { x: -330, y: 260, distance: 8200, bearing: 0, tilt: 36 } },
  { id: 'terminals', label: 'Terminals', view: { x: -1130, y: -410, distance: 1750, bearing: 28, tilt: 50 } },
  { id: 'international', label: 'International', view: { x: -1420, y: -400, distance: 720, bearing: 78, tilt: 56 } },
  { id: 'arrivals', label: '28 arrivals', view: { x: 1250, y: -690, distance: 1500, bearing: 298, tilt: 74 } },
  { id: 'departures', label: '01 departures', view: { x: -520, y: -1180, distance: 1150, bearing: 28, tilt: 70 } },
  { id: 'crossing', label: 'Runway crossing', view: { x: 70, y: 40, distance: 1500, bearing: 345, tilt: 55 } },
  { id: 'tower', label: 'Tower', view: { x: -850, y: -330, h: 50, distance: 520, bearing: 60, tilt: 72 } },
  { id: 'highway', label: 'US-101', view: { x: -1950, y: -700, distance: 950, bearing: 335, tilt: 62 } },
  { id: 'interchange', label: 'I-380', view: { x: -2250, y: 1650, distance: 1500, bearing: 10, tilt: 52 } },
  { id: 'gates', label: 'Gates', view: { x: -1270, y: 160, distance: 300, bearing: 110, tilt: 58 } },
  { id: 'airtrain', label: 'AirTrain', view: { x: -1000, y: -200, distance: 260, bearing: 200, tilt: 62 } },
  { id: 'longhaul', label: 'Long-haul', view: { x: -1560, y: -40, distance: 460, bearing: 240, tilt: 56 } },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
