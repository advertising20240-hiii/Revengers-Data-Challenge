// Shared scoring engine (pure ES module, no dependencies).
// Used by the server, the CLI and the browser UI so that every total is computed by the same code.
//
// Rules (Freedom Broker checklist, "Порядок расчёта"):
//  1. N/A only where allowed and the condition holds (enforced upstream; here: na only if na_allowed).
//  2. "Да" = full weight, "Нет" = 0, scale = value / scale_max * weight.
//  3. N/A criteria are excluded and their weight is redistributed proportionally:
//     total = Σ points(applicable) / Σ weight(applicable) * 100.
//  4. Round half away from zero to 2 decimals using exact rational arithmetic (BigInt), never floats.
//  5. No applicable weighted criterion -> total is not calculated (null).
//  6. Flag criteria (gross errors) carry no points and never change the total.

// ---------- exact rational arithmetic ----------
const B = (n) => BigInt(n);

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Rat {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error('Division by zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static of(x) {
    if (x instanceof Rat) return x;
    if (typeof x === 'bigint') return new Rat(x, 1n);
    const s = String(x).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Not a decimal number: ${x}`);
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace('-', '').split('.');
    const n = B(i + f) * (neg ? -1n : 1n);
    return new Rat(n, 10n ** B(f.length));
  }
  add(o) { o = Rat.of(o); return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
  mul(o) { o = Rat.of(o); return new Rat(this.n * o.n, this.d * o.d); }
  div(o) { o = Rat.of(o); return new Rat(this.n * o.d, this.d * o.n); }
  isZero() { return this.n === 0n; }
  gt(o) { o = Rat.of(o); return this.n * o.d > o.n * this.d; }
  /** Round half away from zero to `digits` decimals; returns a string like "75.63". */
  toFixed(digits = 2) {
    const scale = 10n ** B(digits);
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const scaled = (2n * a * scale + this.d) / (2n * this.d); // floor(x*scale + 1/2)
    const intPart = scaled / scale;
    const frac = (scaled % scale).toString().padStart(digits, '0');
    const out = digits > 0 ? `${intPart}.${frac}` : `${intPart}`;
    return neg && scaled !== 0n ? `-${out}` : out;
  }
  toNumber(digits = 2) { return Number(this.toFixed(digits)); }
}

// ---------- criterion helpers ----------
export const ANSWER_TYPES = ['yes_no', 'yes_no_na', 'scale', 'scale_na', 'flag'];

export function isScale(c) { return c.answer_type === 'scale' || c.answer_type === 'scale_na'; }
export function isFlag(c) { return c.answer_type === 'flag' || c.scored === false; }
export function naAllowed(c) {
  if (typeof c.na_allowed === 'boolean') return c.na_allowed;
  return c.answer_type === 'yes_no_na' || c.answer_type === 'scale_na';
}
export function scaleMax(c) {
  const vals = (c.scale || []).map((s) => Rat.of(s.value));
  if (!vals.length) throw new Error(`Criterion ${c.id} has no scale steps`);
  return vals.reduce((m, v) => (v.gt(m) ? v : m));
}
export function scaleSteps(c) { return (c.scale || []).map((s) => Number(s.value)); }

/**
 * Validate one answer against the criterion definition. Returns a list of problems (empty = ok).
 * answer: { applicable:boolean, answer?: 'yes'|'no', scale_value?: number, flag_types?: string[] }
 */
export function validateAnswer(c, a) {
  const errs = [];
  if (!a) return [`${c.id}: missing answer`];
  if (a.applicable === false) {
    if (!naAllowed(c)) errs.push(`${c.id}: N/A is not allowed for this criterion`);
    return errs;
  }
  if (isScale(c)) {
    const steps = scaleSteps(c);
    if (typeof a.scale_value !== 'number' || !steps.includes(a.scale_value)) {
      errs.push(`${c.id}: scale value ${a.scale_value} is not one of [${steps.join(', ')}]`);
    }
  } else if (a.answer !== 'yes' && a.answer !== 'no') {
    errs.push(`${c.id}: answer must be "yes" or "no"`);
  }
  return errs;
}

/** Points earned by one applicable criterion, as a Rat. */
export function criterionPoints(c, a) {
  const w = Rat.of(c.weight ?? 0);
  if (isScale(c)) return Rat.of(a.scale_value).div(scaleMax(c)).mul(w);
  return a.answer === 'yes' ? w : Rat.of(0);
}

function totalOf(points, weights) {
  if (weights.isZero()) return null;
  return points.div(weights).mul(100);
}

/**
 * Score a full evaluation.
 * @param {object} checklist  { criteria:[...], sections?:[{id,title}] }
 * @param {object} answers    map criterion_id -> answer
 * @returns {{ total:number|null, total_str:string|null, calculated:boolean,
 *            per_criterion:object, section_totals:object, gross:{flag:boolean,types:string[],criteria:string[]},
 *            sum_points:string, sum_weights:string, errors:string[] }}
 */
export function scoreEvaluation(checklist, answers) {
  const errors = [];
  let sumP = Rat.of(0);
  let sumW = Rat.of(0);
  const per = {};
  const sec = {};
  const gross = { flag: false, types: [], criteria: [] };

  for (const c of checklist.criteria) {
    const a = answers[c.id];
    const probs = validateAnswer(c, a);
    if (probs.length) { errors.push(...probs); per[c.id] = { points: null, weight: Number(c.weight ?? 0), effective_weight: null, applicable: null }; continue; }

    if (isFlag(c)) {
      const flagged = a.applicable !== false && a.answer === 'yes';
      if (flagged) {
        gross.flag = true;
        gross.criteria.push(c.id);
        for (const t of a.flag_types || []) if (!gross.types.includes(t)) gross.types.push(t);
      }
      per[c.id] = { points: null, weight: 0, effective_weight: null, applicable: a.applicable !== false, flag: flagged };
      continue;
    }

    const w = Rat.of(c.weight ?? 0);
    const s = c.section || '_';
    sec[s] ??= { p: Rat.of(0), w: Rat.of(0) };
    if (a.applicable === false) {
      per[c.id] = { points: null, weight: Number(c.weight ?? 0), effective_weight: 0, applicable: false };
      continue;
    }
    const p = criterionPoints(c, a);
    sumP = sumP.add(p); sumW = sumW.add(w);
    sec[s].p = sec[s].p.add(p); sec[s].w = sec[s].w.add(w);
    per[c.id] = { points: p, weight: Number(c.weight ?? 0), applicable: true, _w: w };
  }

  // effective weights (share of 100 after redistribution)
  for (const id of Object.keys(per)) {
    const r = per[id];
    if (r.applicable && r._w) {
      r.effective_weight = sumW.isZero() ? 0 : r._w.div(sumW).mul(100).toNumber(2);
      r.points_str = r.points.toFixed(2);
      r.points = r.points.toNumber(2);
      delete r._w;
    }
  }

  const t = totalOf(sumP, sumW);
  const section_totals = {};
  for (const [s, v] of Object.entries(sec)) {
    const st = totalOf(v.p, v.w);
    section_totals[s] = {
      points: v.p.toNumber(2), weight: Number(v.w.toFixed(2)),
      total: st ? st.toNumber(2) : null, total_str: st ? st.toFixed(2) : null, calculated: !!st,
    };
  }

  return {
    total: t ? t.toNumber(2) : null,
    total_str: t ? t.toFixed(2) : null,
    calculated: !!t,
    sum_points: sumP.toFixed(4),
    sum_weights: sumW.toFixed(4),
    per_criterion: per,
    section_totals,
    gross,
    errors,
  };
}

/** Convert compact gold-style labels ('Y'|'N'|'NA'|number) into engine answers. */
export function answersFromLabels(checklist, labels, grossTypes = []) {
  const out = {};
  for (const c of checklist.criteria) {
    const v = labels[c.code ?? c.id] ?? labels[c.id];
    if (v === undefined) continue;
    if (v === 'NA') out[c.id] = { applicable: false };
    else if (typeof v === 'number') out[c.id] = { applicable: true, scale_value: v };
    else out[c.id] = { applicable: true, answer: v === 'Y' ? 'yes' : 'no', flag_types: isFlag(c) && v === 'Y' ? grossTypes : [] };
  }
  return out;
}
