/**
 * Beta posterior math for the learning loop's calibration: the mean, and the quantile the auto-apply rule reads
 * (the 10th percentile of "the owner keeps it"). Pure functions, shared by the worker (deciding) and the api (showing).
 */

/** ln Γ(x) for x > 0 (Lanczos, g=7, n=9): about 15 significant digits. */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The continued fraction of the regularized incomplete beta (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** P(X ≤ x) for X ~ Beta(a, b), a and b > 0. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The q-quantile of Beta(a, b), by bisection on the cdf (to 1e-9). */
export function betaQuantile(q: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The quantile the auto-apply rule compares with τ. */
export const CALIBRATION_LOWER_QUANTILE = 0.1;

/** A bucket's estimate: p the posterior mean, lower its 10th percentile. */
export const betaSummary = (alpha: number, beta: number): { p: number; lower: number } =>
  ({ p: alpha / (alpha + beta), lower: betaQuantile(CALIBRATION_LOWER_QUANTILE, alpha, beta) });

/** The lower bound the auto-apply rule reads: the 10th percentile of Beta(alpha, beta). */
export const betaLower = (alpha: number, beta: number) => betaQuantile(CALIBRATION_LOWER_QUANTILE, alpha, beta);
