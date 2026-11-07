// Transcript normalization + deterministic facts extraction (pure ES module, no I/O).
// Lexicons are passed in by the caller (see config/lexicon/*.json), so the same code runs in Node and in the browser.

const KZ_LETTERS = /[әғқңөұүһі]/iu;
const CYR = /[а-яё]/iu;
const LAT = /[a-z]/i;

/** Parse "MM:SS", "H:MM:SS" or ISO-8601 (7-digit fractions allowed) into absolute seconds (chat) or epoch seconds (voice). */
export function parseTimestamp(ts) {
  if (ts == null) return null;
  const s = String(ts).trim();
  const mmss = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (mmss) {
    const [, a, b, c] = mmss;
    return c !== undefined ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
  }
  // ISO: trim fractional seconds to milliseconds so Date.parse accepts it
  const iso = s.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms / 1000;
}

export function detectLanguage(text, fallback = 'RU') {
  if (!text) return fallback;
  const t = String(text).replace(/\[[^\]]*\]/g, ''); // ignore PII masks
  if (KZ_LETTERS.test(t)) return 'KZ';
  const cyr = (t.match(/[а-яё]/giu) || []).length;
  const lat = (t.match(/[a-z]/gi) || []).length;
  if (cyr === 0 && lat === 0) return fallback;
  return cyr >= lat ? (fallback === 'KZ' ? 'KZ' : 'RU') : 'EN';
}

function fmtOffset(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * Normalize one API record. Keeps original fields; adds numbered lines (1-based, same as transcript index).
 */
export function normalizeRecord(rec, groupId = null) {
  if (!rec || typeof rec !== 'object') throw new Error('Record must be an object');
  if (!rec.conversation_id) throw new Error('Record has no conversation_id');
  const transcript = Array.isArray(rec.transcript) ? rec.transcript : [];
  const abs = transcript.map((t) => parseTimestamp(t?.timestamp));
  const first = abs.find((x) => x != null);
  const lines = transcript.map((t, i) => {
    const off = abs[i] != null && first != null ? Math.round((abs[i] - first) * 1000) / 1000 : null;
    return {
      n: i + 1,
      timestamp: t?.timestamp ?? null,
      offset_seconds: off,
      offset_label: fmtOffset(off),
      speaker: ['client', 'operator', 'bot', 'system'].includes(t?.speaker) ? t.speaker : 'system',
      text: String(t?.text ?? ''),
    };
  });
  const channel = rec.channel === 'voice call' ? 'voice call' : 'agent chat';
  const language = ['RU', 'KZ', 'EN'].includes(String(rec.language).toUpperCase()) ? String(rec.language).toUpperCase() : 'RU';
  return {
    conversation_id: String(rec.conversation_id),
    channel,
    language,
    audio_url: rec.audio_url || null,
    group_id: groupId ?? rec.group_id ?? null,
    transcript,
    lines,
  };
}

function compile(list) { return (list || []).map((p) => new RegExp(p, 'iu')); }
function hits(text, regs) { return regs.filter((r) => r.test(text)).map((r) => r.source); }
function eqAny(text, list) {
  const t = text.trim().toLowerCase();
  return (list || []).some((s) => t === s.trim().toLowerCase() || t.startsWith(s.trim().toLowerCase().replace(/\.$/, '')));
}

/**
 * Deterministic facts. Everything here is a fact about the transcript (line numbers are 1-based);
 * the evaluator uses them as hints and the validator uses them as hard checks.
 */
export function extractFacts(conv, lex) {
  const { events = {}, signals = {} } = lex || {};
  const L = conv.lines;
  const ops = L.filter((l) => l.speaker === 'operator');
  const clients = L.filter((l) => l.speaker === 'client');
  const sys = L.filter((l) => l.speaker === 'system');

  const firstClient = clients.find((l) => l.text.replace(/\[[^\]]*\]/g, '').trim().length > 3) || clients[0];
  const clientLanguage = firstClient ? detectLanguage(firstClient.text, conv.language) : conv.language;
  const lang = ['RU', 'KZ', 'EN'].includes(clientLanguage) ? clientLanguage : conv.language;

  const ev = (key) => sys.filter((l) => eqAny(l.text, events[key])).map((l) => l.n);
  const escalation = ev('escalation');
  const verified = ev('identity_verified');
  const opClosed = ev('operator_closed');
  const clientLeft = ev('client_left');

  // hold / consult segments (voice)
  const segments = [];
  const pairs = [['hold_start', 'hold_end', 'hold'], ['consult_start', 'consult_end', 'consult']];
  for (const [s, e, kind] of pairs) {
    const starts = ev(s);
    const ends = ev(e);
    for (const st of starts) {
      const en = ends.find((x) => x > st) ?? null;
      if (!segments.some((g) => g.kind === kind && g.from <= st && (g.to ?? Infinity) >= st)) {
        segments.push({ kind, from: st, to: en, seconds: en ? round1((L[en - 1].offset_seconds ?? 0) - (L[st - 1].offset_seconds ?? 0)) : null });
      }
    }
  }

  const firstOp = ops[0] || null;
  const greetRe = compile(signals.greeting?.[lang]);
  const greetAny = compile(Object.values(signals.greeting || {}).flat());
  const informalRe = compile(signals.informal_greeting?.[lang]);
  const introRe = compile(signals.introduction?.[lang]);
  const introAny = compile(Object.values(signals.introduction || {}).flat());

  const firstOpFacts = firstOp ? {
    line: firstOp.n,
    operator_name: extractOperatorName(firstOp.text),
    text: firstOp.text,
    greeting_in_client_language: hits(firstOp.text, greetRe).length > 0,
    greeting_any_language: hits(firstOp.text, greetAny).length > 0,
    informal_greeting: hits(firstOp.text, informalRe).length > 0,
    introduction: hits(firstOp.text, introRe).length > 0 || hits(firstOp.text, introAny).length > 0,
  } : null;

  // first reaction: escalation (or first client line) -> first operator line
  const anchor = escalation.length ? L[escalation[0] - 1] : (clients[0] || null);
  const firstReaction = firstOp && anchor && firstOp.offset_seconds != null && anchor.offset_seconds != null
    ? round1(firstOp.offset_seconds - anchor.offset_seconds) : null;

  // signal hits (operator lines only for insult / bypass / disclosure; client lines for complaints)
  const scan = (arr, key) => {
    const regs = compile(signals[key]);
    return arr.map((l) => ({ line: l.n, matches: hits(l.text, regs) })).filter((x) => x.matches.length);
  };
  const disclosure = scan(ops, 'disclosure');
  const firstVerified = verified[0] ?? null;
  const disclosureBeforeVerification = disclosure.filter((d) => firstVerified == null || d.line < firstVerified);

  // mid-dialog waits: client line -> next operator line gap (after the first operator line)
  const waits = [];
  const waitRe = compile(signals.wait_warning);
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (l.speaker !== 'operator' || !firstOp || l.n <= firstOp.n) continue;
    const prevOp = [...L.slice(0, i)].reverse().find((x) => x.speaker === 'operator');
    if (!prevOp || prevOp.offset_seconds == null || l.offset_seconds == null) continue;
    const gap = l.offset_seconds - prevOp.offset_seconds;
    if (gap > 90) {
      const between = L.slice(prevOp.n - 1, l.n - 1).filter((x) => x.speaker === 'operator');
      const warned = between.some((x) => hits(x.text, waitRe).length);
      waits.push({ from_line: prevOp.n, to_line: l.n, seconds: round1(gap), warned });
    }
  }

  const lastOp = ops[ops.length - 1] || null;
  const afterLast = lastOp ? L.slice(lastOp.n) : [];
  const clientAfterLastOp = afterLast.filter((l) => l.speaker === 'client').map((l) => l.n);
  const farewellRe = compile(signals.farewell);
  const offerRe = compile(signals.offer_help);
  const lastOpFacts = lastOp ? {
    line: lastOp.n,
    text: lastOp.text,
    farewell: hits(lastOp.text, farewellRe).length > 0,
    offer_help: hits(lastOp.text, offerRe).length > 0,
    client_lines_after: clientAfterLastOp,
  } : null;

  const endEvent = (() => {
    const lastSys = [...sys].reverse()[0];
    if (!lastSys) return null;
    if (opClosed.includes(lastSys.n)) return { type: 'operator_closed', line: lastSys.n };
    if (clientLeft.includes(lastSys.n)) return { type: 'client_left', line: lastSys.n };
    return null;
  })();

  const talk = { operator_lines: ops.length, client_lines: clients.length, bot_lines: L.filter((l) => l.speaker === 'bot').length, system_lines: sys.length };
  const duration = L.length && L[L.length - 1].offset_seconds != null ? round1(L[L.length - 1].offset_seconds) : null;

  return {
    client_language: lang,
    record_language: conv.language,
    channel: conv.channel,
    operator_participated: ops.length > 0,
    counts: talk,
    duration_seconds: duration,
    escalation_lines: escalation,
    identity_verified_lines: verified,
    operator_closed_lines: opClosed,
    client_left_lines: clientLeft,
    end_event: endEvent,
    segments,
    first_operator: firstOpFacts,
    first_reaction_seconds: firstReaction,
    last_operator: lastOpFacts,
    waits_over_90s: waits,
    complaint_signals: scan(clients, 'complaint'),
    insult_signals: scan(ops, 'insult'),
    bypass_signals: scan(ops, 'bypass'),
    disclosure_signals: disclosure,
    disclosure_before_verification: disclosureBeforeVerification,
  };
}

function round1(x) { return Math.round(x * 10) / 10; }

/** Best-effort operator name from the self-introduction ("[Имя скрыто]" when masked, null when absent). */
export function extractOperatorName(text) {
  if (!text) return null;
  if (/\[Имя скрыто\]/u.test(text)) return '[Имя скрыто]';
  const pats = [
    /[Мм]еня зовут\s+([А-ЯЁ][а-яё]+)/u,
    /(?:^|[\s,.!])я\s+([А-ЯЁ][а-яё]+)/u,
    /[Мм]енің атым\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)/u,
    /(?:^|[\s,.!])[Мм]ен\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)/u,
    /\bI'?m\s+([A-Z][a-z]+)/,
    /\bmy name is\s+([A-Z][a-z]+)/i,
  ];
  for (const p of pats) {
    const m = p.exec(text);
    if (m) return m[1].replace(/(мын|мін|пын|пін|бын|бін)$/u, '');
  }
  return null;
}

/** Render numbered transcript lines for prompts: "[#12 03:58 system] text" (consult segments marked). */
export function renderTranscript(conv, facts) {
  const inSeg = (n) => (facts?.segments || []).find((s) => n > s.from && (s.to == null || n < s.to));
  return conv.lines.map((l) => {
    const seg = inSeg(l.n);
    const tag = seg ? ` ${seg.kind}` : '';
    return `[#${l.n} ${l.offset_label} ${l.speaker}${tag}] ${l.text}`;
  }).join('\n');
}
