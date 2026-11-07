# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## 2026-11-07 (night)

### Changed
- **Criterion 07 «Завершение» follows the checklist wording literally**: «Да» only when the operator's final turn has a farewell **and** a summary / next step / offer of further help. A courtesy-only closing («Пожалуйста. Хорошего дня!», «Оқасы жоқ. Сау болыңыз!», «You're welcome. Bye!») is «Нет», even after the client thanks. Implemented in `services/evaluator/rules.js` (`COURTESY_RE`, `substantive()`); policy line 07 (`services/evaluator/prompts/policy.v1.ru.md`) and the checklist guidance rewritten in the same words. Basis: the checklist text and the organizers' answer in the participants chat to exactly this question («Внимательно перечитайте чеклист по данному пункту»).
- **Team gold v1.1**: criterion 07 relabelled (Да → Нет) in 31 dialogs; reason and dialog list in `tests/gold/dev_labels.json → revisions`; v1.0 kept as `tests/gold/dev_labels.v1.0.json`.
- **Criterion 06 is judged in its own model call** (`CQA_JUDGE_SOLO`, default `06`; empty disables): 70.8 % exact inside the all-criteria call vs 84.6 % alone on 65 DEV dialogs, holdout 75 → 95 %, at one extra free call per dialog.
- **Criterion weight is no longer part of the prompt or the cache key** — a weight-only checklist change is pure re-scoring with zero model calls; evaluations stored before this change are still reused.
- **Default provider with nothing configured is `offline`** (replays the committed cache) instead of guessing a local endpoint.
- DEV re-evaluated live on the free alem.plus API at 0 ₸: `reports/runs/alem_qwen3-8_v4_closure.json` (86 calls) and `alem_qwen3-8_v5_solo06.json` (80 calls); `reports/calibration.{json,md}`, `data/seed/DEV.evaluations.json` and `results/dev/results.json` regenerated. Hybrid (product), all 65: 01 98.5 · 02 89.2 · 03 98.5 · 04 92.3 (±1 96.9) · 05 95.4 · 06 84.6 (±1 100) · 07 95.4 · 08 100 % (8/8, 0 false flags); exact total 53.8 %, within ±5 67.7 %, MAE 6.18 (model only 6.45, rules only 11.36); holdout 100 / 85 / 100 / 85 / 100 / 95 / 95 / 100 %, MAE 7.61; RU 93.6 · KZ 95.8 · EN 94.2 %. Test–retest 96.9 % is carried over from the earlier live measurement on the previous policy version (`reports/runs/retest_injection.json`).
- `npm run export:results` and `GET /api/results.json` take evaluations of the **active checklist version** (`--checklist <version>` / `checklist_version` to choose another); the card and the list row use the same rule.
- Calibration `--cache-only` skips the injection check (it needs live calls) instead of refusing to start, and keeps the last live measurement in the report.

### Added
- Interface in three languages — **RU · ҚАЗ · EN** — with a header switcher; dates, units and plurals follow the language; server-side labels shown in the chosen language.
- Card block **«Почему снижена оценка»**: every criterion that lost points, the points lost, the answer and a link to the evidence line, largest loss first.
- Projector zoom **A+** in the header (remembered per browser); checklist version picker in the evaluate dialog; offline-aware checklist editor (says which changes would need the model).
- Read-only single-file static demo: `npm run build:static` → `dist/static/index.html`; GitHub Pages workflow `.github/workflows/pages.yml` (manual run); free deployment notes in `docs/DEPLOY.md`.
- Group-scoped card links `#/c/<id>/g/<group>` so a dialog id present in both DEV and the control set opens the right dialog.
- Tests for all of the above (`tests/fixes.test.js`, `tests/static.test.js`); 73 tests in total.
- Screenshots retaken with the new UI (01, 02, 09, 10) and added: 11 Kazakh card, 12 English dialogs list, 13 «Почему снижена оценка».

### Fixed
- **Honest provenance on fallback**: when the model was unreachable and rules stood in, the trace records `model_requested`, uses `heuristic-fallback` when every criterion came from rules, and the cost line says the model was unavailable — the model's name is never put on an answer it did not give.
- A re-uploaded transcript with changed content is evaluated again instead of reusing the old result (transcript hash stored per dialog); uploads with no usable dialog are rejected with 400.
- Review reasons are recomputed after a reviewer decision (a decided criterion no longer keeps the dialog in «Требует проверки»); a decision refused by the scoring engine leaves the evaluation and the appeal untouched.
- Confirmation dialogs resolve with the user's choice.

### Security
- Server binds **127.0.0.1** by default (`HOST=0.0.0.0` only by explicit choice).
- Dataset fetch accepts only the organizers' endpoint from the server settings (`CQA_DATA_URL`); a client-supplied URL is refused.
- The audio proxy fetches only the `audio_url` of a loaded dialog and only public http(s) hosts — loopback, private, link-local and internal names are refused, every redirect hop re-checked (`server/lib/net.js`).

## [Unreleased]

### Added
- Shared scoring engine `packages/scoring` with exact rational arithmetic (half-away-from-zero rounding, N/A redistribution, section subtotals, separate gross-error flags) and unit tests, including the `60.5 / 80 → 75.63` vector and all 65 gold DEV dialogs.
- Transcript normalizer and deterministic facts extractor `packages/transcript` (numbered lines, offsets, client language, operator name, system events, hold/consult segments, lexicon hits) with per-language lexicons in `config/lexicon/`.
- Checklist v1 (`config/checklist.v1.json`) transcribed from the organizers' checklist: 8 criteria, 4 sections, criterion- and answer-level guidance.
- JSON Schemas for Checklist, Evaluation and Appeal (`schemas/`) and a dependency-free validator test.
- Dynamics 365 single-file web-resource builder `scripts/build-d365.mjs` (`npm run build:d365`) with the Xrm client-URL hook and a 5 MB guard.
- Repository hygiene audit `scripts/audit-repo.sh` (`npm run audit`) with optional external deny-lists.
- GitHub Actions CI: tests, audit, D365 build.
- Documentation: scoring policy, appeals, architecture, Dynamics 365 integration, security, research ledger, tooling, demo script, control-day runbook, limitations.

[Unreleased]: https://github.com/advertising20240-hiii/Revengers-Data-Challenge/commits/main
