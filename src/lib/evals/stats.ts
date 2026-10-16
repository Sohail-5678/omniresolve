/**
 * Eval statistics: 95% bootstrap confidence intervals (10,000 resamples, fixed seed),
 * percentiles, and Cohen's kappa. Deterministic so re-running an eval on the same raw
 * results reproduces the same intervals.
 */
import { Rng } from "@/lib/util/prng";

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function bootstrapCI(values: number[], { resamples = 10_000, seed = 1234, alpha = 0.05 } = {}): [number, number] {
  if (!values.length) return [0, 0];
  const rng = new Rng(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[rng.int(0, values.length - 1)];
    stats.push(s / values.length);
  }
  stats.sort((a, b) => a - b);
  const lo = stats[Math.floor((alpha / 2) * resamples)];
  const hi = stats[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)];
  return [round(lo), round(hi)];
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function rate(n: number, d: number): number {
  return d ? round(n / d) : 0;
}

export function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Cohen's kappa for two raters over the same items (categorical labels). */
export function cohensKappa(a: string[], b: string[]): number {
  if (a.length !== b.length || !a.length) return 0;
  const labels = [...new Set([...a, ...b])];
  const n = a.length;
  const po = a.filter((x, i) => x === b[i]).length / n;
  let pe = 0;
  for (const l of labels) pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  return pe === 1 ? 1 : round((po - pe) / (1 - pe));
}
