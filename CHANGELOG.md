# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

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
