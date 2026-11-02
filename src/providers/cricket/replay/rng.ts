/** Deterministic PRNG (mulberry32). Same seed → same match, so tests can assert exact outcomes. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  static fromString(text: string): Rng {
    return new Rng(hashString(text));
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Weighted choice: weights need not sum to 1. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r < 0) return value;
    }
    return (entries.at(-1) as readonly [T, number])[0];
  }

  /** k distinct integers from [0, n). */
  sample(n: number, k: number): number[] {
    const pool = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < Math.min(k, n); i += 1) {
      const j = i + Math.floor(this.next() * (n - i));
      [pool[i], pool[j]] = [pool[j] as number, pool[i] as number];
    }
    return pool.slice(0, Math.min(k, n));
  }
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
