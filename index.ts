import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/core";
import { resolveConfig } from "./src/config.js";
import { openDb, closeDb } from "./src/db.js";
import { registerNotifyCli } from "./src/cli.js";
import { createNotifyService } from "./src/service.js";
import { tick, type TickLogger } from "./src/tick.js";
import { validateDestinations } from "./src/validate.js";
import type { RuntimeBridge } from "./src/types.js";

export type {
  TelegramSendOpts,
  SlackSendOpts,
  SignalSendOpts,
  ChannelName,
  Destination,
  NotifyConfig,
  QueueRow,
} from "./src/types.js";

const notifyPlugin: OpenClawPluginDefinition = {
  id: "notify",
  name: "Notify",
  description: "Shared notifications queue with batched LLM-formatted delivery and multi-destination routing",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig ?? {});
    const logger: TickLogger = {
      debug: (m) => api.logger.debug?.(m),
      info: (m) => api.logger.info(m),
      warn: (m) => api.logger.warn(m),
      error: (m) => api.logger.error(m),
    };
    const runtime = api.runtime as unknown as RuntimeBridge;

    // Resolve DB path once at register time. Same path in both the CLI
    // process (shelled out via `openclaw notify enqueue`) and the long-
    // running service process, so both read/write the same queue.
    const stateDir = api.resolvePath("~/.openclaw/state/plugins/notify");
    const dbPath = path.join(stateDir, "notifications.db");

    // Validate destinations lazily on first tick, then cache. Deferring until
    // the first tick (vs. running it inline here) avoids false negatives from
    // channel plugins that register after us.
    //
    // On failure we retry every tick (a late-registering channel plugin
    // should recover without restart) but throttle error logging so a
    // persistent misconfiguration doesn't spam the log once per tick.
    let activeDestinations: Set<string> | null = null;
    let lastValidationErrorAt = 0;
    const VALIDATION_LOG_THROTTLE_MS = 10 * 60_000;
    const ensureValidated = (): Set<string> | null => {
      if (activeDestinations) return activeDestinations;
      try {
        activeDestinations = validateDestinations(config, runtime, logger);
        return activeDestinations;
      } catch (err) {
        const now = Date.now();
        if (now - lastValidationErrorAt > VALIDATION_LOG_THROTTLE_MS) {
          lastValidationErrorAt = now;
          logger.error(`notify: ${err instanceof Error ? err.message : String(err)}`);
        }
        return null;
      }
    };

    const tickFn = async (opts: { force: boolean; onlyDestination?: string }) => {
      const active = ensureValidated();
      if (!active) return;
      const db = openDb(dbPath);
      try {
        await tick(db, config, runtime, logger, { ...opts, activeDestinations: active });
      } finally {
        closeDb(db);
      }
    };

    api.registerCli(
      ({ program }) => {
        registerNotifyCli({
          program: program as never,
          dbPath,
          config,
          tickFn,
          runtime,
        });
      },
      { commands: ["notify"] },
    );

    let runningService: ReturnType<typeof createNotifyService> | null = null;

    api.registerService({
      id: "notify-flusher",
      start: async (_ctx: OpenClawPluginServiceContext) => {
        // Validate up-front at service start so we fail loud if the default
        // destination is unusable; the tick fn would also catch it but only
        // on its first run.
        if (!ensureValidated()) return;
        const svc = createNotifyService({
          intervalMs: config.tickIntervalSec * 1000,
          tickFn: () => tickFn({ force: false }),
          onError: (err) => logger.error(`notify: tick failed: ${err instanceof Error ? err.message : String(err)}`),
        });
        await svc.start();
        runningService = svc;
      },
      stop: async () => {
        if (runningService) {
          await runningService.stop();
          runningService = null;
        }
      },
    });
  },
};

export default notifyPlugin;
