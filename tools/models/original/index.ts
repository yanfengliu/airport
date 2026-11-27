// Our own models, listed for tools/models/polyfork.ts to write beside Polyfork's: one for each
// thing the app draws that Polyfork has no model of.

import { AIRLINER_MODELS } from './airliner.ts';
import { LANDMARK_MODELS } from './landmarks.ts';
import { TRAIN_MODELS, type OriginalSpec } from './trains.ts';

export type { OriginalSpec } from './trains.ts';

export const ORIGINALS: OriginalSpec[] = [...AIRLINER_MODELS, ...TRAIN_MODELS, ...LANDMARK_MODELS];
