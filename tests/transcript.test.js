import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTimestamp, normalizeRecord, extractOperatorName } from '../packages/transcript/index.js';
import { prepareConversation } from '../packages/transcript/node.js';

const dev = JSON.parse(readFileSync(new URL('../data/dev/DEV.json', import.meta.url), 'utf8')).data.records;
const gold = JSON.parse(readFileSync(new URL('./gold/dev_labels.json', import.meta.url), 'utf8')).labels;
const G = Object.fromEntries(gold.map((g) => [g.conversation_id, g]));

test('timestamps: MM:SS and ISO with 7-digit fractions + offset', () => {
  assert.equal(parseTimestamp('03:58'), 238);
  assert.equal(parseTimestamp('1:02:03'), 3723);
  const a = parseTimestamp('2026-11-03T13:10:00.6388245+00:00');
  const b = parseTimestamp('2026-11-03T13:10:15.5558925+00:00');
  assert.ok(Math.abs(b - a - 14.917) < 0.002);
  assert.equal(parseTimestamp('garbage'), null);
});

test('DEV dataset shape: 65 records, 1268 lines, 1-based numbering', () => {
  assert.equal(dev.length, 65);
  const convs = dev.map((r) => normalizeRecord(r, 'DEV'));
  assert.equal(convs.reduce((s, c) => s + c.lines.length, 0), 1268);
  for (const c of convs) c.lines.forEach((l, i) => assert.equal(l.n, i + 1));
  const voice = convs.filter((c) => c.channel === 'voice call');
  assert.equal(voice.length, 5);
  assert.ok(voice.every((c) => c.audio_url && c.lines[0].offset_seconds === 0));
});

test('facts: first operator line greeting+intro agrees with gold 01 on >= 64/65', () => {
  let agree = 0;
  for (const r of dev) {
    const f = prepareConversation(r, 'DEV').facts;
    const p = f.first_operator && f.first_operator.greeting_in_client_language && f.first_operator.introduction && !f.first_operator.informal_greeting ? 'Y' : 'N';
    if (p === G[r.conversation_id].expected['01']) agree++;
  }
  assert.ok(agree >= 64, `agree=${agree}`);
});

test('facts: disclosure before verification on the three known cases', () => {
  for (const id of ['p1-ru-009', 'p1-kz-015', 'p1-en-014']) {
    const f = prepareConversation(dev.find((r) => r.conversation_id === id), 'DEV').facts;
    assert.ok(f.disclosure_before_verification.length > 0, id);
  }
});

test('facts: insult and bypass signals', () => {
  const f29 = prepareConversation(dev.find((r) => r.conversation_id === 'p1-ru-029'), 'DEV').facts;
  assert.ok(f29.insult_signals.length > 0);
  const f22 = prepareConversation(dev.find((r) => r.conversation_id === 'p1-ru-022'), 'DEV').facts;
  assert.ok(f22.bypass_signals.length > 0);
});

test('facts: client language and operator names', () => {
  assert.equal(extractOperatorName('Сәлеметсіз бе, мен Айбекпін.'), 'Айбек');
  assert.equal(extractOperatorName('Hi, I\'m Maya from support.'), 'Maya');
  assert.equal(extractOperatorName('Здравствуйте! Меня зовут Алина.'), 'Алина');
  assert.equal(extractOperatorName('Фридом брокера [Имя скрыто] Здравствуйте'), '[Имя скрыто]');
  for (const r of dev) {
    const f = prepareConversation(r, 'DEV').facts;
    if (r.channel === 'agent chat') assert.equal(f.client_language, r.language, r.conversation_id);
  }
});

test('no operator lines -> operator_participated=false', () => {
  const c = prepareConversation({ conversation_id: 'x', channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:00', speaker: 'client', text: 'Алло' }, { timestamp: '00:05', speaker: 'bot', text: 'Здравствуйте' }] });
  assert.equal(c.facts.operator_participated, false);
  assert.equal(c.facts.first_operator, null);
});
