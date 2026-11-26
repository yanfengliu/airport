// The simulation's only source of randomness: a small seeded generator with named sub-streams, so
// one system drawing more numbers does not change what another system gets.

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed || 0x9e3779b9;
  }

  /** A generator for one purpose, derived from this one's seed and a label, not from its position. */
  fork(label: string): Rng {
    return new Rng((Math.imul(this.seed ^ 0x85ebca6b, 0xc2b2ae35) ^ hashString(label)) >>> 0);
  }

  /** Uniform in [0, 1). */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** Pick an index with probability proportional to its weight. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i += 1) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    return items[this.weightedIndex(items.map(weight))];
  }

  normal(mean: number, deviation: number): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Normal, clamped to [min, max]. */
  bounded(mean: number, deviation: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, this.normal(mean, deviation)));
  }

  exponential(mean: number): number {
    return -mean * Math.log(Math.max(1e-12, 1 - this.next()));
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}
