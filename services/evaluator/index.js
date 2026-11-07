// Evaluator service: facts → judge (LLM or heuristic) → validator → repair → fallback → verifier → cache.
// Public interface: PROMPT_VERSION, providerInfo(), probeProvider(), evaluateConversation(), secondOpinion().
import { isFlag } from '../../packages/scoring/index.js';
import { cacheGet, cachePut, cacheKey, cacheStats } from './cache.js';
import { sha256 } from './lib/hash.js';
import { resultsArray, extractJson } from './lib/json.js';
import {
  PROMPT_VERSION as PV, POLICY_TEXT, POLICY_HASH, buildSystemPrompt, buildUserPrompt, judgeSchema,
  VERIFIER_SYSTEM, VERIFIER_SCHEMA, buildVerifierUser, SECOND_OPINION_SYSTEM, SECOND_OPINION_SCHEMA, renderCriterion, renderFacts,
} from './prompt.js';
import { renderTranscript } from '../../packages/transcript/index.js';
import { isRuleCriterion, applyRule, noOperatorResult, heuristicResult, hintFor } from './rules.js';
import { normalizeResult, validateResult, autoFix } from './validator.js';
import { resolveProvider, providerStatus, defaultProviderName, defaultModelFor, defaultVerifierFor, kzModelFor, cloudAllowed, LOCAL_PROVIDERS } from './providers/index.js';
import { probe as probeOpenAI } from './providers/openai.js';
import { readFileSync, existsSync } from 'node:fs';

// Per-criterion decision source measured on the tune split (config/routing.json). A criterion routed to "rule"
// takes the deterministic result; the model's label is kept as a second opinion and a disagreement lowers confidence.
const ROUTING_FILE = new URL('../../config/routing.json', import.meta.url);
let routing = null;
function routeFor(c) {
  if (process.env.CQA_ROUTING === 'off') return 'llm';
  if (routing === null) { try { routing = existsSync(ROUTING_FILE) ? JSON.parse(readFileSync(ROUTING_FILE, 'utf8')) : { criteria: [] }; } catch { routing = { criteria: [] }; } }
  const e = (routing.criteria || []).find((x) => x.code === c.code && x.definition === c.definition);
  return e?.source || 'llm';
}
function routeConfidence(c, agree) {
  const e = (routing?.criteria || []).find((x) => x.code === c.code && x.definition === c.definition);
  const v = e?.confidence?.[agree ? 'agree' : 'disagree'];
  return typeof v === 'number' ? v : null;
}
const ruLabel = (r) => (!r ? '—' : r.applicable === false ? 'N/A' : r.scale_value != null ? String(r.scale_value) : r.answer === 'yes' ? 'Да' : r.answer === 'no' ? 'Нет' : '—');

export const PROMPT_VERSION = PV;
export { POLICY_HASH, cacheStats };

const HARDWARE = process.env.CQA_HARDWARE || 'RTX 4050';
const JUDGE_BATCH_LOCAL = Number(process.env.CQA_JUDGE_BATCH || 3);
const MAX_RETRIES = Number(process.env.CQA_RETRIES || 2);

// ---------- concurrency ----------
let active = 0;
const queue = [];
function limit() { return Math.max(1, Number(process.env.CQA_CONCURRENCY || 3)); }
async function withSlot(fn) {
  if (active >= limit()) await new Promise((r) => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

// ---------- provider info ----------
let probed = null; // last probe of the local endpoint
export async function probeProvider(name = defaultProviderName()) {
  if (name === 'openai' || name === 'ollama') { probed = { at: new Date().toISOString(), ...(await probeOpenAI()) }; }
  return providerInfo({ provider: name });
}

export function providerInfo(opts = {}) {
  const provider = opts.provider || defaultProviderName();
  const model = opts.model || defaultModelFor(provider);
  const verifier_model = opts.verifierModel !== undefined ? opts.verifierModel : defaultVerifierFor(provider, model);
  let st = providerStatus(provider);
  if ((provider === 'openai' || provider === 'ollama') && probed) st = { ...st, available: probed.available, reason: probed.reason, probed_at: probed.at };
  return {
    provider, model, verifier_model, kz_model: kzModelFor(provider), available: !!st.available, reason: st.reason, roles: st.roles, quota: st.quota && Object.keys(st.quota).length ? st.quota : undefined,
    local: LOCAL_PROVIDERS.includes(provider), cloud_allowed: cloudAllowed(), prompt_version: PROMPT_VERSION, policy_hash: POLICY_HASH,
    cost_note: provider === 'alem' ? `0 ₸ — бесплатный API alem.plus (${model || 'модель не задана'})` : LOCAL_PROVIDERS.includes(provider) ? `0 ₸ — ${provider === 'heuristic' ? 'детерминированные правила без модели' : `локальная модель ${model} на ${HARDWARE}`}` : 'облачная модель, цена по прайс-листу',
  };
}

// ---------- helpers ----------
function pickCriteria(checklist, ids) {
  const all = checklist.criteria || [];
  if (!ids || !ids.length) return all;
  const set = new Set(ids);
  return all.filter((c) => set.has(c.id) || set.has(c.code));
}

function callRecord(role, model, r) {
  return {
    role, model: r.model || model,
    input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0, cache_read_tokens: r.usage?.cache_read_tokens || 0,
    cost_usd: Number(r.cost_usd || 0), latency_ms: r.latency_ms || 0,
  };
}

async function callWithRetry(prov, req, cfg, ctx, signal) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try { return await withSlot(() => prov.mod.complete({ ...req, signal }, cfg, ctx)); } catch (e) {
      lastErr = e;
      if (/aborted|нулевых затрат|Офлайн|не задан|не установлен/.test(e.message) || attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function chunk(arr, size) {
  if (!size || size >= arr.length) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function costNote(provider, model, seconds) {
  if (provider === 'heuristic') return '0 ₸ — детерминированные правила без модели';
  if (LOCAL_PROVIDERS.includes(provider)) return `0 ₸ — локальная модель ${model} на ${HARDWARE}, ~${Math.round(seconds)} с на диалог`;
  return `облачная модель ${model}, цена по прайс-листу`;
}

/** Judge a batch of criteria with the model; returns {results:{id -> normalized}, issues:[], calls:[]} after validation + one repair. */
async function judgeBatch({ conv, checklist, criteria, prov, model, cfg, examples, signal }) {
  const system = buildSystemPrompt(checklist, criteria, examples);
  const user = buildUserPrompt(conv, criteria);
  const schema = judgeSchema(criteria);
  const ctx = { conversationId: conv.conversation_id, criteria };
  const calls = [];
  const issues = [];
  const final = {};
  const byId = new Map(criteria.map((c) => [c.id, c]));

  const parse = (resp) => {
    const out = {};
    for (const raw of resultsArray(resp.json ?? extractJson(resp.text))) {
      const cid = raw?.criterion_id || raw?.id || raw?.code;
      const c = byId.get(cid) || criteria.find((x) => x.code === cid);
      if (c) out[c.id] = raw;
    }
    return out;
  };

  const first = await callWithRetry(prov, { system, user, schema, model, role: 'judge', maxTokens: 6000 }, cfg, ctx, signal);
  calls.push(callRecord('judge', model, first));
  let raws = parse(first);
  let repaired = false;

  let pending = [];
  for (const c of criteria) {
    const raw = raws[c.id];
    if (!raw) { pending.push({ c, violations: [`${c.code || c.id}: модель не вернула результат для критерия`] }); continue; }
    const norm = normalizeResult(raw, c);
    const viol = validateResult(norm, c, conv);
    if (!viol.length) { final[c.id] = norm; continue; }
    // harmless deterministic fixes first (missing checked range / N/A reason / evidence); a repair call only for what remains
    const fixed = autoFix(norm, c, conv);
    const viol2 = validateResult(fixed, c, conv);
    if (!viol2.length) { final[c.id] = { ...fixed, confidence: Math.min(fixed.confidence, 0.8) }; issues.push(...viol.map((v) => `исправлено автоматически: ${v}`)); continue; }
    pending.push({ c, violations: viol2, norm: fixed });
  }

  if (pending.length) {
    repaired = true;
    const list = pending.map((p) => p.violations.map((v) => `- ${v}`).join('\n')).join('\n');
    const repairUser = `${user}\n\nВаш предыдущий ответ не прошёл проверку. Нарушения:\n${list}\n\nИсправьте ТОЛЬКО критерии ${pending.map((p) => p.c.id).join(', ')} с учётом нарушений и верните JSON по той же схеме (только эти критерии).`;
    issues.push(...pending.flatMap((p) => p.violations));
    try {
      const second = await callWithRetry(prov, { system, user: repairUser, schema: judgeSchema(pending.map((p) => p.c)), model, role: 'judge', maxTokens: 6000 }, cfg, ctx, signal);
      calls.push(callRecord('repair', model, second));
      raws = parse(second);
    } catch (e) {
      issues.push(`repair: ${e.message}`);
      raws = {};
    }
    const still = [];
    for (const p of pending) {
      const raw = raws[p.c.id];
      if (raw) {
        const norm = normalizeResult(raw, p.c);
        const viol = validateResult(norm, p.c, conv);
        if (!viol.length) { final[p.c.id] = { ...norm, confidence: Math.min(norm.confidence, 0.7) }; continue; }
        // try harmless auto-fixes before falling back
        const fixed = autoFix(norm, p.c, conv);
        const viol2 = validateResult(fixed, p.c, conv);
        if (!viol2.length) { final[p.c.id] = { ...fixed, confidence: Math.min(fixed.confidence, 0.6) }; continue; }
        still.push({ ...p, violations: viol2 });
      } else still.push(p);
    }
    for (const p of still) {
      issues.push(...p.violations.map((v) => `после повтора: ${v}`));
      final[p.c.id] = heuristicResult(conv, p.c, { fallback: true, issues: p.violations });
    }
  }
  return { results: final, issues, calls, repaired, prompt_hash: sha256(system) };
}

async function verifyBatch({ conv, criteria, results, prov, verifierModel, cfg, signal }) {
  const user = buildVerifierUser(conv, criteria, results);
  const ctx = { conversationId: conv.conversation_id, criteria };
  const resp = await callWithRetry(prov, { system: VERIFIER_SYSTEM, user, schema: VERIFIER_SCHEMA, model: verifierModel, role: 'verifier', maxTokens: 2000 }, cfg, ctx, signal);
  const payload = resp.json ?? extractJson(resp.text);
  const checks = Array.isArray(payload?.checks) ? payload.checks : resultsArray(payload);
  const changes = [];
  for (const ch of checks) {
    if (!ch || ch.verdict !== 'change') continue;
    const r = results.find((x) => x.criterion_id === ch.criterion_id);
    if (!r) continue;
    const from = !r.applicable ? 'N/A' : (r.scale_value != null ? r.scale_value : r.answer);
    const nv = ch.new_value || {};
    const to = nv.applicable === false ? 'N/A' : (nv.scale_value != null ? nv.scale_value : (nv.answer ?? '?'));
    if (String(from) === String(to)) continue;
    changes.push({ criterion_id: r.criterion_id, from, to, reason: String(ch.reason || '').slice(0, 300) });
    r.confidence = Math.max(0.2, Math.round((r.confidence - 0.25) * 100) / 100);
    r.explanation = `${r.explanation} Проверяющая модель предложила ${to}: ${String(ch.reason || '').slice(0, 160)} — уверенность снижена.`;
  }
  return { call: callRecord('verifier', verifierModel, resp), changes };
}

function labelOf(r) { return !r.applicable ? 'N/A' : (r.scale_value != null ? String(r.scale_value) : `${r.answer}${r.flag_types?.length ? `[${r.flag_types.join(',')}]` : ''}`); }

/** Second judge pass with a Kazakh-specialised model; disagreement lowers confidence (recorded, never overrides). */
async function kzSecondOpinion({ conv, checklist, criteria, results, prov, kzModel, cfg, examples, signal }) {
  const system = buildSystemPrompt(checklist, criteria, examples);
  const user = buildUserPrompt(conv, criteria);
  const ctx = { conversationId: conv.conversation_id, criteria };
  const resp = await callWithRetry(prov, { system, user, schema: judgeSchema(criteria), model: kzModel, role: 'kz', maxTokens: 4000 }, cfg, ctx, signal);
  const disagreements = [];
  for (const raw of resultsArray(resp.json ?? extractJson(resp.text))) {
    const c = criteria.find((x) => x.id === raw?.criterion_id || x.code === raw?.criterion_id);
    const r = c && results.find((x) => x.criterion_id === c.id);
    if (!r) continue;
    const alt = normalizeResult(raw, c);
    if (validateResult(alt, c, conv).length) continue; // ignore invalid second opinions
    const a = labelOf(r); const b = labelOf(alt);
    if (a === b) continue;
    disagreements.push({ criterion_id: c.id, judge: a, kz: b, reason: String(alt.explanation || '').slice(0, 200) });
    r.confidence = Math.max(0.2, Math.round((r.confidence - 0.2) * 100) / 100);
    r.explanation = `${r.explanation} Казахскоязычная модель (${kzModel}) оценила иначе: ${b} — требуется проверка.`;
  }
  return { call: callRecord('kz', kzModel, resp), disagreements };
}

// ---------- main entry ----------
export async function evaluateConversation(conv, checklist, opts = {}) {
  const started = Date.now();
  const prov = resolveProvider(opts.provider);
  const providerName = prov.name;
  const model = opts.model || (prov.mod?.isFake ? 'fake' : defaultModelFor(providerName));
  const verifierModel = opts.verifierModel !== undefined ? opts.verifierModel : (prov.name === 'fake' ? (opts.verify ? model : null) : defaultVerifierFor(providerName, model));
  const verify = opts.verify !== false && !!verifierModel && providerName !== 'heuristic' && providerName !== 'offline';
  const kzModel = opts.kzModel !== undefined ? opts.kzModel : (prov.name === 'fake' ? null : kzModelFor(providerName));
  const cfg = { allowCloud: cloudAllowed() };
  const criteria = pickCriteria(checklist, opts.criteriaIds);
  const trace = {
    prompt_version: PROMPT_VERSION, prompt_hash: null, policy_hash: POLICY_HASH, provider: providerName, model, verifier_model: verify ? verifierModel : null,
    kz_model: kzModel || null,
    calls: [], cost_usd: 0, latency_ms: 0, cache: { hits: [], misses: [] }, validator_issues: [], verifier_changes: [], kz_disagreements: [], cost_note: '',
  };
  const out = {};

  // 1. operator absent → everything N/A, no model call
  const operatorLines = conv.lines.filter((l) => l.speaker === 'operator').length;
  if (operatorLines === 0) {
    for (const c of criteria) out[c.id] = noOperatorResult(c);
    trace.latency_ms = Date.now() - started;
    trace.cost_note = '0 ₸ — вызов модели не требовался (оператор не участвовал)';
    trace.prompt_hash = sha256(buildSystemPrompt(checklist, criteria, opts.examples));
    return { results: criteria.map((c) => out[c.id]), trace };
  }

  // 2. rule criteria + cache lookup
  const llmCriteria = [];
  for (const c of criteria) {
    if (isRuleCriterion(c)) { out[c.id] = applyRule(conv, c); trace.calls.push({ role: 'rule', model: c.evaluator, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, latency_ms: 0 }); continue; }
    const key = cacheKey({ conv, criterion: c, policyText: POLICY_TEXT, promptVersion: PROMPT_VERSION, model });
    const hit = opts.force ? null : cacheGet(key);
    if (hit?.result) { out[c.id] = { ...hit.result }; trace.cache.hits.push(c.id); if (hit.verifier_change) trace.verifier_changes.push(hit.verifier_change); }
    else { llmCriteria.push({ c, key }); trace.cache.misses.push(c.id); }
  }

  // 3. judge misses
  let promptHash = null;
  if (llmCriteria.length) {
    const misses = llmCriteria.map((x) => x.c);
    const judged = [];
    if (providerName === 'heuristic') {
      for (const c of misses) judged.push(heuristicResult(conv, c));
      promptHash = sha256(buildSystemPrompt(checklist, misses, opts.examples));
    } else if (providerName === 'offline') {
      await prov.mod.complete({ model }, cfg, { conversationId: conv.conversation_id, criteria: misses });
    } else {
      const batchSize = opts.batchSize ?? (providerName === 'alem' ? Number(process.env.CQA_JUDGE_BATCH_ALEM || 0) : (LOCAL_PROVIDERS.includes(providerName) && providerName !== 'fake' ? JUDGE_BATCH_LOCAL : 0));
      const batches = chunk(misses, batchSize);
      // provider failure (quota exhausted, network) degrades to conservative rule results instead of failing the evaluation
      const batchResults = await Promise.all(batches.map((b) => judgeBatch({ conv, checklist, criteria: b, prov, model, cfg, examples: opts.examples, signal: opts.signal })
        .catch((e) => {
          if (opts.signal?.aborted) throw e;
          const results = {};
          for (const c of b) results[c.id] = heuristicResult(conv, c, { fallback: true, issues: [`модель недоступна: ${String(e.message || e).slice(0, 120)}`] });
          return { results, issues: [`judge: ${String(e.message || e).slice(0, 200)}`], calls: [], prompt_hash: null };
        })));
      for (const br of batchResults) {
        trace.calls.push(...br.calls);
        trace.validator_issues.push(...br.issues);
        promptHash ??= br.prompt_hash;
        for (const c of misses) if (br.results[c.id]) judged.push(br.results[c.id]);
      }
      // 4. verifier over model-judged results (not over fallbacks)
      if (verify && judged.length) {
        // verifier mode: all | low (only uncertain results — saves quota) | off
        const vMode = opts.verifyMode || process.env.CQA_VERIFY || (providerName === 'alem' ? 'low' : 'all');
        const vThreshold = Number(process.env.CQA_VERIFY_THRESHOLD || 0.75);
        const toVerify = vMode === 'off' ? [] : judged.filter((r) => r.source === 'ai' && (vMode === 'all' || (r.confidence ?? 0) < vThreshold));
        if (toVerify.length) {
          try {
            const v = await verifyBatch({ conv, criteria: misses.filter((c) => toVerify.some((r) => r.criterion_id === c.id)), results: toVerify, prov, verifierModel, cfg, signal: opts.signal });
            trace.calls.push(v.call);
            trace.verifier_changes.push(...v.changes);
          } catch (e) { trace.validator_issues.push(`verifier: ${e.message}`); }
        }
      }
      // 4b. Kazakh dialogs: independent second opinion from a Kazakh-specialised model
      if (kzModel && kzModel !== model && (conv.facts?.client_language === 'KZ' || conv.language === 'KZ')) {
        const aiResults = judged.filter((r) => r.source === 'ai');
        if (aiResults.length) {
          try {
            const k = await kzSecondOpinion({ conv, checklist, criteria: misses.filter((c) => aiResults.some((r) => r.criterion_id === c.id)), results: aiResults, prov, kzModel, cfg, examples: opts.examples, signal: opts.signal });
            trace.calls.push(k.call);
            trace.kz_disagreements.push(...k.disagreements);
          } catch (e) { trace.validator_issues.push(`kz: ${e.message}`); }
        }
      }
    }
    // 5. cache per criterion
    const now = new Date().toISOString();
    for (const { c, key } of llmCriteria) {
      const r = judged.find((x) => x.criterion_id === c.id) || heuristicResult(conv, c, { fallback: true, issues: ['нет результата'] });
      r.source = r.source === 'rule' ? 'rule' : 'ai';
      out[c.id] = r;
      const vc = trace.verifier_changes.find((x) => x.criterion_id === c.id) || null;
      if (String(r.rule_applied || '').startsWith('fallback:')) continue; // never cache a fallback: retry the model next time
      cachePut(key, { key, conversation_id: conv.conversation_id, criterion_id: c.id, provider: providerName, model, prompt_version: PROMPT_VERSION, prompt_hash: promptHash, policy_hash: POLICY_HASH, created_at: now, result: r, verifier_change: vc });
    }
  }

  trace.prompt_hash = promptHash || sha256(buildSystemPrompt(checklist, criteria, opts.examples));
  trace.cost_usd = Math.round(trace.calls.reduce((s, c) => s + (c.cost_usd || 0), 0) * 1e6) / 1e6;
  trace.latency_ms = Date.now() - started;
  trace.cost_note = llmCriteria.length ? costNote(providerName, model, trace.latency_ms / 1000) : '0 ₸ — результат из кэша';
  // measured routing: deterministic result where it is more accurate; model label kept as a second opinion
  if (!['heuristic', 'fake'].includes(providerName) && operatorLines > 0) {
    trace.routing = [];
    for (const c of criteria) {
      const cur = out[c.id];
      const route = routeFor(c);
      if (!cur || cur.source === 'rule' && !String(cur.rule_applied || '').startsWith('fallback:') || !route.startsWith('rule')) continue;
      const h = heuristicResult(conv, c);
      // "rule+model_no": the model's «Нет» (a concrete miss it found) overrides the rule's «Да»
      if (route === 'rule+model_no' && cur.answer === 'no' && h.answer === 'yes' && cur.source === 'ai') {
        trace.routing.push({ criterion_id: c.id, source: 'ai', model_label: ruLabel(cur), rule_label: ruLabel(h), agree: false, note: 'model_no_overrides_rule_yes' });
        out[c.id] = { ...cur, confidence: routeConfidence(c, false) ?? Math.min(cur.confidence ?? 0.7, 0.7) };
        continue;
      }
      const agree = ruLabel(h) === ruLabel(cur);
      out[c.id] = { ...h, source: 'rule', rule_applied: `маршрут: детерминированная проверка (${h.rule_applied})`, confidence: routeConfidence(c, agree) ?? (agree ? Math.max(h.confidence, 0.8) : Math.min(h.confidence, 0.55)), second_opinion: { source: 'ai', model, label: ruLabel(cur), explanation: cur.explanation } };
      trace.routing.push({ criterion_id: c.id, source: 'rule', model_label: ruLabel(cur), rule_label: ruLabel(h), agree });
    }
  }
  // flag criteria are never N/A
  for (const c of criteria) if (isFlag(c) && out[c.id] && !out[c.id].applicable && operatorLines > 0) { out[c.id] = { ...out[c.id], applicable: true, na_reason: null, answer: 'no', flag_types: [], checked_range: out[c.id].checked_range || [1, conv.lines.length] }; }
  return { results: criteria.map((c) => out[c.id]), trace };
}

// ---------- second opinion for appeals ----------
export async function secondOpinion(conv, checklist, criterionId, originalResult, appealComment, opts = {}) {
  const prov = resolveProvider(opts.provider);
  const providerName = prov.name;
  const model = opts.model || (providerName === 'fake' ? 'fake' : defaultModelFor(providerName));
  const criterion = (checklist.criteria || []).find((c) => c.id === criterionId || c.code === criterionId);
  if (!criterion) throw new Error(`Критерий ${criterionId} не найден в чек-листе`);
  const orig = originalResult || {};
  const origLabel = orig.applicable === false ? 'N/A' : (orig.scale_value != null ? `шкала ${orig.scale_value}` : (orig.answer === 'yes' ? 'Да' : orig.answer === 'no' ? 'Нет' : '—'));

  if (providerName === 'heuristic' || providerName === 'offline' || isRuleCriterion(criterion)) {
    const h = isRuleCriterion(criterion) ? applyRule(conv, criterion) : heuristicResult(conv, criterion);
    return {
      suggestion: { applicable: h.applicable, answer: h.answer, scale_value: h.scale_value, flag_types: h.flag_types || [] },
      rationale: `Второе мнение по детерминированным фактам транскрипта (модель не использовалась). ${h.explanation} Исходная оценка: ${origLabel}.`,
      model: providerName === 'heuristic' ? 'heuristic-v1' : (isRuleCriterion(criterion) ? criterion.evaluator : 'cache-only'),
      cost_usd: 0, cost_note: '0 ₸ — без вызова модели',
    };
  }
  const system = `${SECOND_OPINION_SYSTEM}\n<CHECKLIST>\n${renderCriterion(criterion)}\n</CHECKLIST>\n\n<POLICY>\n${POLICY_TEXT}\n</POLICY>`;
  const user = `<FACTS>\n${renderFacts(conv, [criterion])}\n</FACTS>\n\n<TRANSCRIPT untrusted="true">\n${renderTranscript(conv, conv.facts)}\n</TRANSCRIPT>\n\n<ORIGINAL>\n${criterion.id}: ${origLabel}; доказательства: ${(orig.evidence || []).map((e) => `#${e.line}`).join(', ') || '—'}; объяснение: ${orig.explanation || '—'}\n</ORIGINAL>\n\n<APPEAL untrusted="true">\n${String(appealComment || '').slice(0, 2000)}\n</APPEAL>\n\nДайте независимое второе мнение по критерию ${criterion.id}. Только JSON.`;
  const resp = await callWithRetry(prov, { system, user, schema: SECOND_OPINION_SCHEMA, model, maxTokens: 1500 }, { allowCloud: cloudAllowed() }, { conversationId: conv.conversation_id, criteria: [criterion] }, opts.signal);
  const j = resp.json ?? extractJson(resp.text) ?? {};
  const sug = normalizeResult({ ...(j.suggestion || {}), evidence: [{ line: conv.facts?.first_operator?.line || 1, why: '' }] }, criterion);
  const problems = validateResult(sug, criterion, conv).filter((p) => !/доказател/.test(p));
  let suggestion = { applicable: sug.applicable, answer: sug.answer, scale_value: sug.scale_value, flag_types: sug.flag_types || [] };
  let rationale = typeof j.rationale === 'string' && j.rationale.trim() ? j.rationale.trim() : 'Модель не дала обоснования.';
  if (problems.length) {
    const h = heuristicResult(conv, criterion);
    suggestion = { applicable: h.applicable, answer: h.answer, scale_value: h.scale_value, flag_types: h.flag_types || [] };
    rationale = `Ответ модели не прошёл проверку (${problems.join('; ')}); предложение сформировано по фактам транскрипта. ${h.explanation}`;
  }
  return { suggestion, rationale, model: resp.model || model, cost_usd: Number(resp.cost_usd || 0), cost_note: LOCAL_PROVIDERS.includes(providerName) ? `0 ₸ — локальная модель ${model}` : 'цена по прайс-листу' };
}

export { hintFor, heuristicResult, applyRule };
