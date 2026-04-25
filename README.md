# @openclaw/notify

Shared notifications queue for OpenClaw with batched LLM-formatted delivery. Consumer skills (todo, calendar, email-digest, …) shell out to a single CLI to enqueue; the plugin batches, formats, and dispatches via your already-configured OpenClaw channels.

## Features

- **One queue for all skills** — reminders from todo and events from calendar collapse into a single natural-language message.
- **Multi-destination routing** — route `--destination work` to Slack and the rest to Telegram (or iMessage / Discord / Signal).
- **LLM formatting via your OpenClaw keys** — no per-skill API keys. Cheap model auto-selected per provider.
- **Quiet hours** — TZ-aware window that accumulates notifications and flushes on the other side.
- **Dedup** — consumers pass a `--dedup-key`; repeated enqueues within a window update the pending row in place. Dedup is scoped to `(source, dedup_key, destination)`, so `todo` and `calendar` can both use `--dedup-key reminder:1` without colliding. Once a row has been claimed by a tick, further enqueues with the same key insert a new row (safer than mutating a row that's mid-delivery).

## Install

```bash
openclaw plugins install @openclaw/notify
```

## Configure

Under `plugins.notify` in your OpenClaw config:

```json
{
  "tickIntervalSec": 1800,
  "destinations": {
    "default": { "channel": "telegram", "chatId": "123456789" },
    "work":    { "channel": "slack",    "chatId": "#alerts" },
    "family":  { "channel": "telegram", "chatId": "-100555" }
  },
  "quietHours": { "start": "21:00", "end": "08:00", "tz": "America/New_York" },
  "llm":        { "enabled": true, "provider": null, "model": null },
  "personality": "cheery and terse",
  "dedupWindowMin": 15
}
```

`destinations.default` is required. Add as many named destinations as you want. Valid channel values: `telegram | discord | slack | signal | imessage` — each must correspond to a channel plugin you have registered in OpenClaw.

## CLI

### From a consumer skill

```bash
openclaw notify enqueue \
  --source todo \
  --category reminder \
  --data '{"text":"Buy beans","priority":"high"}' \
  --dedup-key todo:42:reminder
```

Add `--destination work` to route to a named destination. Add `--no-format` to skip LLM formatting and use the template.

### Manual flush / admin

```bash
openclaw notify send              # flush now (respects quiet hours)
openclaw notify send --force      # bypass quiet hours
openclaw notify send --destination work
openclaw notify list              # print pending rows as JSON
openclaw notify list --failed     # only rows that exceeded the retry budget
openclaw notify list --all        # include sent and failed rows
openclaw notify purge --older-than 30d
openclaw notify retry --id 42     # reset one failed row so the next tick re-delivers
openclaw notify retry --all       # reset every failed row
openclaw notify doctor            # probe config, destinations, LLM, and queue
openclaw notify doctor --skip-llm # skip the live LLM API probe
```

`notify send` prints a one-line summary so callers can see what happened:

```
delivered 3, failed 1 (will retry)
skipped: quiet hours (pass --force to override)
no pending rows
no pending rows (2 backing off, next in 8m)
```

`notify doctor` exits non-zero when anything is unhealthy (a destination channel isn't registered, the configured LLM provider has no key, the live LLM probe fails, etc.), so it composes cleanly with shell scripts, CI checks, and systemd `ExecStartPre=`.

## How it works

The service runs on an interval inside the OpenClaw gateway. Each tick:

1. If in quiet hours → skip.
2. Load up to 50 unsent, unreserved rows (oldest first).
3. Group by destination.
4. For each destination: partition `should_format=1` (LLM) vs `0` (template); atomically claim the batch, format, deliver.
5. Stamp `sent_at` on delivered rows; release reservations on failure so the next tick retries.

LLM provider is auto-selected from the first configured provider in `anthropic → openai → google → groq → ollama` that has a key. Cheap model auto-selection: `claude-haiku-4-5`, `gpt-4o-mini`, `gemini-1.5-flash`, `llama-3.1-8b-instant`, `llama3.2:3b`.

## Prompt injection

Each batch generates a fresh random 8-hex nonce. Every piece of consumer text is wrapped in `<<<DATA:{nonce} ... {nonce}:END>>>`, and the system prompt tells the model to treat delimited content as data only. Any literal fence markers that appear inside user text are stripped to `[fence]` before wrapping, so a malicious consumer can't close the block early. The nonce rotates per batch, so knowing one tick's delimiter doesn't help attack the next.

## Reliability

Delivery is **at-least-once**. Duplicates are rare but possible (see the duplicate window below); for notification workloads that's an acceptable trade. If you need exactly-once, dedupe on the receiver side by `(source, category, time-bucket)`.

- **Crash recovery.** Rows are atomically claimed via `UPDATE ... RETURNING` before delivery. If a tick process crashes between claim and `sent_at` being stamped, the reservation times out after 10 minutes and the row becomes eligible again.
- **Retry with exponential backoff.** Delivery failures schedule `next_attempt_at = now + backoff(attempts)`. Schedule: `2 min → 10 min → 30 min → 2 h → 6 h → 12 h → 24 h → 24 h → 24 h`, then tombstone after 10 failed attempts (~3.8 days of coverage). A channel outage that lasts a few hours recovers without operator action. Markdown parse errors on Telegram/Signal are retried once in plain-text mode before counting as a failure.
- **Tombstoned rows are not auto-retried.** After 10 failures the row is stamped `failed_at`; `notify doctor` surfaces the count and `notify retry --id <n>` (or `--all`) re-enters it with a fresh budget.
- **No concurrent double-claim.** A single `UPDATE ... RETURNING` guarantees that two ticks racing on the same row can't both enter the send phase — only one sees it in the result set.
- **Concurrent processes.** The CLI and service each open the same SQLite file in WAL mode with `busy_timeout = 5 s`, so transient lock contention on a simultaneous enqueue retries inside SQLite rather than raising `SQLITE_BUSY`.
- **Duplicate window.** If the gateway crashes after the channel API returned success but before `sent_at` is persisted, the row is re-sent after the reservation expires. A crashed-mid-flight tick trades one possible duplicate for not losing the message.
- **LLM timeout.** The HTTP call to the LLM provider is bounded by a 30 s AbortSignal so a hung provider can't freeze the tick loop; on timeout the batch falls back to the template and is delivered anyway.

## Channel plugin contract

This plugin dispatches through the gateway runtime's channel registry. A channel plugin must expose the exact method name and opts shape below on `runtime.channel.<name>`:

| Channel    | Method                | Call shape                                                                                                  |
|------------|-----------------------|-------------------------------------------------------------------------------------------------------------|
| `telegram` | `sendMessageTelegram` | `(chatId, text, { textMode?: "markdown" \| "plain", messageThreadId?: number }) => Promise<{ messageId }>` |
| `slack`    | `sendMessageSlack`    | `(channel, text, { threadTs?: string }) => Promise<{ messageId }>`                                          |
| `discord`  | `sendMessageDiscord`  | `(channelId, text) => Promise<{ messageId }>`                                                               |
| `signal`   | `sendMessageSignal`   | `(recipient, text, { textMode?: "markdown" \| "plain" }) => Promise<{ messageId }>`                         |
| `imessage` | `sendMessageIMessage` | `(recipient, text) => Promise<{ messageId }>`                                                               |

The typed shapes are exported from `@openclaw/notify` (`TelegramSendOpts`, `SlackSendOpts`, `SignalSendOpts`) for channel-plugin authors who want to type-check the call site.

If a channel listed in your config isn't registered at service-start time, this plugin logs a warning at most once per 10 minutes per destination and leaves rows bound for that destination untouched (they'll flush when the channel plugin comes online — no data loss).

## Delivery failures

Each row has a 10-attempt budget spread over ~3.8 days of exponential backoff (see Reliability above). After 10 failed deliveries the row is stamped `failed_at` and skipped on future ticks so a permanently-broken message can't loop forever. Inspect with `openclaw notify list --failed` and either re-deliver with `openclaw notify retry --id <n>` (or `--all`) or delete the row with a direct SQL `DELETE`.

## Troubleshooting

**Notifications are suddenly terse / template-looking.** The LLM batch call is
failing and the tick is falling back to the per-row template. Check the gateway
log for `notify: LLM <provider>/<model> failing` — the first fallback per
(provider, model) per hour is logged at error level with the underlying cause.
Typical fixes: rotate the API key, or pin `llm.model` to a current model id
(models get deprecated). Run `openclaw notify doctor` for a live probe.

**Destination never flushes.** A channel plugin listed in `destinations.<name>.channel`
isn't registered at service-start time. `notify doctor` will flag it, and the
tick logs a warning at most once per 10 minutes until the channel plugin comes
online. Rows queued for an unregistered channel are held, not dropped.

## Data location / uninstall

State lives in `~/.openclaw/state/plugins/notify/notifications.db` (a SQLite file with WAL sidecars). The DB file is chmod 0600 so only the owning user can read it — notification payloads can include personal reminders and calendar subjects. Deleting that directory is equivalent to a fresh install. Rows with `sent_at IS NOT NULL` can be garbage-collected via `openclaw notify purge --older-than 30d`.

## License

MIT-0
