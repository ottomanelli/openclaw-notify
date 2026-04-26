# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-26

Initial release.

### Added
- Shared notifications queue (SQLite, WAL) with batched LLM-formatted delivery
  through OpenClaw-registered channels (telegram, slack, discord, signal, imessage).
- Multi-destination routing — `destinations.default` plus arbitrarily-named
  destinations selectable via `notify enqueue --destination <name>`.
- LLM provider auto-selection from OpenClaw's configured providers
  (anthropic → openai → google → groq → ollama), with cheap-model defaults
  per provider and an opt-in `llm.provider` / `llm.model` override.
- Quiet hours (TZ-aware) that hold routine deliveries; `notify send --force`
  bypasses them.
- Source-scoped dedup on `(source, dedup_key, destination)` so multiple
  consumer skills can use the same ergonomic dedup keys without colliding.
- Atomic `UPDATE … RETURNING` claim semantics so two ticks racing on the same
  row can't both deliver it (at-least-once with a documented duplicate window).
- Exponential backoff schedule
  (`2m → 10m → 30m → 2h → 6h → 12h → 24h × 3`) with tombstone after 10
  failed attempts (~3.8 days of coverage); `notify retry --id <n>` /
  `notify retry --all` re-enters tombstoned rows.
- Plain-text retry for Telegram/Signal markdown parse errors before counting
  the row as a failure.
- Throttled `error`-level logging when the LLM batch falls back to the
  template — first occurrence per `(provider, model)` per hour.
- `notify doctor` — probes config, destinations, LLM provider, and queue
  health; flags orphaned rows bound to retired destinations; surfaces unset
  optional knobs as a "Tips" trailer; non-zero exit composes with shell /
  CI / `systemd ExecStartPre=`.
- `notify list [--failed | --all]`, `notify purge --older-than <duration>`
  for ops.
- `notify send` summary output: `delivered N, failed M (will retry)` /
  `skipped: quiet hours` / `no pending rows (M backing off, next in Xm)`.
- Idempotent schema migration: adds `delivery_attempts`, `failed_at`,
  `next_attempt_at` columns and rewrites the dedup index in place when
  upgrading from older on-disk DBs (no manual migration step).
- Multi-process safety — both the gateway tick service and the CLI open the
  same WAL-mode DB with `busy_timeout = 5s` so transient lock contention
  retries inside SQLite rather than surfacing `SQLITE_BUSY`.
- DB chmod `0600` on open — notification payloads can include personal
  reminders / calendar subjects.
- Prompt-injection mitigation: each LLM batch wraps consumer text in a
  random per-batch nonce-fenced block; literal fence markers in user text
  are stripped before wrapping so a malicious consumer can't escape.
- Plugin manifest `uiHints` for every config field — labels, help text,
  placeholders, `advanced` flags — for rendering in OpenClaw's config UI.
