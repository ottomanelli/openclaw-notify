# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **A reminder repeated while it was held is said once.** A consumer that repeats a reminder every few hours
  (a to-do reminded every two) queues it again under the same dedup key while the earlier ones are still
  held, by quiet hours say. Enqueue folds a repeat only into a row younger than `dedupWindowMin` (15
  minutes by default), so a night of quiet hours left five rows for one reminder, and the model wording
  the batch said it "shows up five times" and offered to clear the duplicates. Rows of one batch with the
  same source and dedup key are now one notification: the newest is said, all are marked sent. Setting
  `dedupWindowMin` longer than your quiet hours also keeps the queue itself to one row.
- **The model is told today's date.** A reminder's due date reached the model with nothing to compare it
  to, and one two days past was called "coming up soon". The instructions now give today's date (in the
  quiet hours' time zone, or the machine's), say that a due date before it is overdue, and ask for the
  reminders only: nothing about the list itself, and no offers beyond the reply hints.


### Added
- **`notify send` and `notify doctor` are done by the running Gateway.** Run from a terminal, a script or a
  scheduled job, they are short-lived CLI processes, into which OpenClaw loads neither channel plugins nor
  model keys: a destination with a chat could not be delivered from there (`<channel> channel not
  registered`, counted against the row's retry budget), LLM formatting fell back to the template, and
  `doctor` reported healthy setups as broken. The plugin now registers Gateway methods `notify.flush` and
  `notify.doctor`, and the two commands call them through OpenClaw's own CLI Gateway client. With no Gateway
  running they say so and work in their own process as before, except that rows for a chat are left
  pending instead of being tried and failed. `--local` skips the Gateway. `send` prints `left N pending`
  when rows were left that way.
- **Any OpenClaw channel as a destination.** `channel` was limited to telegram, discord, slack, signal and
  imessage. It may now be any installed channel's id (a channel plugin of your own, for example); such a
  channel is sent plain text through its outbound adapter, cut to the adapter's `textChunkLimit`.
  Needs an OpenClaw with outbound adapters.
- **Webhook destinations.** A destination may list `webhooks` (`[{ "url": "...", "headers": {...} }]`). Each
  delivered message is also POSTed there as JSON: `{ text, plain, destination, sources, categories, count }`
  (`plain` is `text` without Markdown marks). With a `chatId`, the chat decides success and webhooks are
  best-effort (a failure is logged, the rows stay sent, so the chat is not messaged twice). With webhooks and
  no `chatId`, the webhooks are the delivery: all must answer 2xx or the batch is retried. Existing
  chat-only destinations are unchanged.
- **`notify send --source <name>` and `--category <name>`.** Flush only one producer's rows. A job that
  enqueues a message and wants it out now no longer sends everything else that is waiting with it (rows
  that need LLM formatting can fail when flushed from a plain CLI process; they stay queued for the
  Gateway's own tick).

### Fixed
- **Claude's newer models work for LLM formatting.** With `llm.provider: "anthropic"` and a model such as
  `claude-haiku-5-5`, every formatting call failed with HTTP 400 (`temperature is deprecated for this
  model`) and messages went out as the plain template. The Anthropic request no longer sends `temperature`
  (older Claude models do not need it), allows 2000 tokens instead of 500 because these models think
  before answering and that thinking counts against the cap, and reads the answer from the reply's text
  blocks instead of its first block, which is a thinking block when the model thought first. An empty
  answer now names the reason (`stop_reason`).

- `notify doctor` no longer reports a destination made of webhooks only as "channel NOT registered":
  it has no chat, so there is no channel to look for.
- Sending on current OpenClaw. The per-channel send functions the plugin called
  (`runtime.channel.telegram.sendMessageTelegram` and its siblings) no longer exist;
  messages now go through `runtime.channel.outbound.loadAdapter(<channel>)` and the
  adapter's `sendText`. The old functions are still used when the loader is absent.
- The flusher never started on current OpenClaw: a plugin is no longer loaded at Gateway
  startup unless its manifest says `activation.onStartup: true`. Enqueueing worked (the
  CLI loads the plugin on demand) but nothing was ever delivered. The manifest now says so.
- LLM formatting with newer OpenAI models (`gpt-5.6-luna`, `gpt-6-luna`, ...), which
  answered HTTP 400 to `max_tokens` and to a non-default `temperature`. The OpenAI
  provider now sends `max_completion_tokens` and no temperature. Other
  OpenAI-compatible providers are unchanged.

### Added
- **`llm.model: "utility"`**: the small model of whichever provider OpenClaw is set to use, so
  formatting stays cheap and follows a change of provider with no change here. It is the
  utility model OpenClaw's settings name, or else this plugin's cheap model for the provider
  of the agent's own model. Like any named model it needs
  `plugins.entries.notify.llm.allowModelOverride: true`.

### Changed
- The cheap model for Anthropic is `claude-haiku-5-5` (was `claude-haiku-4-5`).
- **LLM formatting goes through OpenClaw.** Where OpenClaw offers plugins its own completion
  (`api.runtime.llm.complete`), the plugin uses it for every batch and for `notify doctor`'s
  probe, instead of asking OpenClaw for a key and calling the provider itself. OpenClaw picks
  the model, holds the key and shapes the request, so a provider's newer models no longer
  need a change here. **With `llm.provider` and `llm.model` both `null` the model is now
  OpenClaw's own for the agent**, not the cheap model of the first provider with a key.
  **A named model now needs `plugins.entries.notify.llm.allowModelOverride: true`**; without
  it OpenClaw refuses the override, `doctor` reports it and messages use the template. On an
  older OpenClaw the plugin calls the provider itself as before. See "Which model formats"
  in the README.

- The cheap default model for OpenAI is `gpt-6-luna` (was `gpt-4o-mini`).
- `better-sqlite3` ^12, which has builds for Node 24 to 26. With ^11 on Node 24 the
  plugin could not open its queue, so `notify enqueue` failed and nothing was delivered.

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
