import type { Terminals } from './layout.ts';

// SFO's Courtyard 3 post-security passenger walkway (OSM way 1241804696, level 1).
export const COURTYARD_3 = 'Courtyard 3 Connector';

export function courtyard3(terminals: Terminals) {
  return terminals.areas.find((a) => a.kind === 'corridor' && a.name === COURTYARD_3 && a.level === 1)?.poly;
}
