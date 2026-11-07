// Orchestrates one evaluation: reuse of unchanged criteria, learning-loop examples, evaluator call, assembly, persistence.
import { buildEvaluation, noOperatorResults, stripResult } from './evaluations.js';
import { criterionHash } from './checklists.js';
import { HttpError } from '../lib/http.js';

export class EvalEngine {
  constructor({ db, config, data, checklists, evaluator }) {
    this.db = db; this.config = config; this.data = data; this.checklists = checklists;
    this.evaluator = evaluator || null;
    this.evaluatorError = null;
  }

  setEvaluator(ev, error = null) { this.evaluator = ev; this.evaluatorError = error; }

  providerInfo() {
    if (!this.evaluator) return { provider: null, model: null, verifier_model: null, available: false, reason: this.evaluatorError || 'Модуль оценки не загружен' };
    try {
      const info = typeof this.evaluator.providerInfo === 'function' ? this.evaluator.providerInfo() : {};
      return { available: true, ...info };
    } catch (e) { return { provider: null, model: null, available: false, reason: e?.message || String(e) }; }
  }

  requireEvaluator() {
    if (!this.evaluator || typeof this.evaluator.evaluateConversation !== 'function') {
      throw new HttpError(503, `Модуль оценки недоступен: ${this.evaluatorError || 'services/evaluator/index.js не найден'}`);
    }
  }

  /** Stored evaluations for a conversation (newest first). */
  evaluationsFor(groupId, conversationId) {
    return this.db.evaluations.find((e) => e.conversation_id === conversationId && e.group_id === groupId && e.mode === 'stored')
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  latestFor(groupId, conversationId, version = null) {
    const list = this.evaluationsFor(groupId, conversationId);
    if (version != null) return list.find((e) => e.checklist_version === Number(version)) ?? null;
    // default: the evaluation for the active checklist version, otherwise the newest one
    const active = this.checklists.active();
    return (active && list.find((e) => e.checklist_version === active.version)) || list[0] || null;
  }

  /** Learning loop: most recent decided appeals per criterion become bounded few-shot examples. */
  examples(criteriaIds = null) {
    const max = this.config.maxExamplesPerCriterion;
    const decided = this.db.appeals.find((a) => a.decision && a.status !== 'open').sort((a, b) => (b.decision.decided_at || '').localeCompare(a.decision.decided_at || ''));
    const perCriterion = new Map();
    const out = [];
    for (const a of decided) {
      if (criteriaIds && !criteriaIds.includes(a.criterion_id)) continue;
      const n = perCriterion.get(a.criterion_id) || 0;
      if (n >= max) continue;
      perCriterion.set(a.criterion_id, n + 1);
      out.push({
        criterion_id: a.criterion_id, conversation_id: a.conversation_id, excerpt: a.excerpt || '',
        final: { applicable: a.final?.applicable ?? a.original.applicable, answer: a.final?.answer ?? a.original.answer ?? null, scale_value: a.final?.scale_value ?? a.original.scale_value ?? null },
        reviewer_note: a.decision.reviewer_note, outcome: a.decision.outcome,
      });
    }
    return out;
  }

  /**
   * Evaluate one conversation against a checklist.
   * opts: { force, criteriaIds, signal, mode:'stored'|'simulation', persist }
   */
  async evaluate(row, checklist, opts = {}) {
    const conv = this.data.prepare(row);
    const mode = opts.mode || 'stored';
    const wanted = opts.criteriaIds?.length ? checklist.criteria.filter((c) => opts.criteriaIds.includes(c.id)) : checklist.criteria;
    let results = [];
    let trace = { prompt_version: null, provider: 'none', model: null, calls: [], cost_usd: 0, latency_ms: 0, cache: { hits: [], misses: [] }, validator_issues: [], verifier_changes: [], reused: [] };
    const t0 = Date.now();

    if (!conv.facts.operator_participated) {
      results = noOperatorResults(checklist);
      trace.provider = 'rule';
    } else {
      // 1. reuse results of criteria whose definition hash is unchanged (latest stored evaluation of this conversation)
      const prior = opts.force ? null : this.latestFor(row.group_id, conv.conversation_id);
      const priorBy = new Map((prior?.results || []).map((r) => [r.criterion_hash || `${r.criterion_id}:?`, r]));
      const toRun = [];
      for (const c of wanted) {
        const h = criterionHash(c);
        const old = priorBy.get(h);
        if (old && old.criterion_id === c.id && !opts.force) {
          const reused = { ...stripResult(old) };
          if (old.ai_original) reused.ai_original = old.ai_original;
          if (old.review) reused.review = old.review;
          results.push(reused);
          trace.reused.push(c.id);
        } else toRun.push(c.id);
      }
      // 2. everything else goes to the evaluator
      if (toRun.length) {
        this.requireEvaluator();
        const examples = this.examples(toRun);
        const res = await this.evaluator.evaluateConversation(conv, checklist, {
          criteriaIds: toRun, force: !!opts.force, examples, signal: opts.signal,
          provider: this.config.provider || undefined, model: this.config.model || undefined, verifierModel: this.config.verifierModel || undefined,
        });
        if (!res || !Array.isArray(res.results)) throw new HttpError(502, 'Модуль оценки вернул некорректный результат');
        results.push(...res.results.map(stripResult));
        trace = { ...trace, ...(res.trace || {}), reused: trace.reused, examples_used: examples.length };
        // criteria reused from the previous evaluation count as cache hits: only new/changed criteria reached the model
        trace.cache = { hits: [...new Set([...(res.trace?.cache?.hits || []), ...trace.reused])], misses: res.trace?.cache?.misses || [] };
      } else if (prior) {
        trace = { ...trace, prompt_version: prior.prompt_version, provider: prior.provider, model: prior.model, cache: { hits: trace.reused, misses: [] } };
      }
      // keep checklist order
      const order = new Map(checklist.criteria.map((c, i) => [c.id, i]));
      results.sort((a, b) => (order.get(a.criterion_id) ?? 999) - (order.get(b.criterion_id) ?? 999));
    }
    trace.latency_ms = Number(trace.latency_ms) || (Date.now() - t0);
    trace.cost_usd = Number(trace.cost_usd) || 0;
    const ev = buildEvaluation({ conv, checklist, results, trace, mode, groupId: row.group_id });
    if (mode === 'stored' && opts.persist !== false) {
      this.db.evaluations.put(ev);
      this.db.scheduleSave();
    }
    return ev;
  }

  async secondOpinion(appeal, evaluation, checklist, row) {
    this.requireEvaluator();
    if (typeof this.evaluator.secondOpinion !== 'function') throw new HttpError(503, 'Модуль оценки не поддерживает второе мнение');
    const conv = this.data.prepare(row);
    const result = evaluation.results.find((r) => r.criterion_id === appeal.criterion_id);
    const res = await this.evaluator.secondOpinion(conv, checklist, appeal.criterion_id, stripResult(result), appeal.comment, { provider: this.config.provider || undefined, model: this.config.model || undefined });
    return { suggestion: res?.suggestion ?? null, rationale: res?.rationale ?? '', model: res?.model ?? null, cost_usd: Number(res?.cost_usd) || 0, cost_note: res?.cost_note ?? null, created_at: new Date().toISOString() };
  }
}

/** Try to load the evaluator module; the server must start even if it is missing or broken. */
export async function loadEvaluator(root) {
  try {
    const { pathToFileURL } = await import('node:url');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const file = join(root, 'services', 'evaluator', 'index.js');
    if (!existsSync(file)) return { evaluator: null, error: 'services/evaluator/index.js не найден' };
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.evaluateConversation !== 'function') return { evaluator: null, error: 'модуль не экспортирует evaluateConversation' };
    return { evaluator: mod, error: null };
  } catch (e) {
    return { evaluator: null, error: `ошибка загрузки модуля оценки: ${e?.message || e}` };
  }
}
