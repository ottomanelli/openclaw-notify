import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/core";
import { resolveConfig } from "./src/config.js";
import { openDb, closeDb } from "./src/db.js";
import { registerNotifyCli, type SendOptions } from "./src/cli.js";
import { createNotifyService } from "./src/service.js";
import { tick, type TickLogger, type TickResult } from "./src/tick.js";
import { validateDestinations, destinationUsableHere } from "./src/validate.js";
import { setHostConfig } from "./src/deliver.js";
import { runDoctor } from "./src/cli.js";
import {
  FLUSH_METHOD,
  DOCTOR_METHOD,
  parseFlushRequest,
  flushViaGateway,
  doctorViaGateway,
  type FlushReply,
} from "./src/gateway.js";
import { callGatewayFromThisProcess } from "./src/gateway-client.js";
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
    // The outbound adapters take the host config with every send.
    setHostConfig(api.config);

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

    const tickFn = async (opts: SendOptions): Promise<TickResult | void> => {
      const active = ensureValidated();
      if (!active) return;
      const db = openDb(dbPath);
      try {
        return await tick(db, config, runtime, logger, { ...opts, activeDestinations: active });
      } finally {
        closeDb(db);
      }
    };

    // A flush in the CLI's own process, used when no Gateway answers. OpenClaw loads no
    // channel plugins into a CLI process, so a destination with a chat cannot be
    // delivered from here: its rows are left pending for the Gateway rather than tried
    // and counted as failures. Destinations made of webhooks go out as usual.
    const localTickFn = async (opts: SendOptions): Promise<TickResult | void> => {
      const active = ensureValidated();
      if (!active) return;
      const usable = new Set<string>();
      for (const name of active) {
        if (await destinationUsableHere(runtime, config.destinations[name])) usable.add(name);
      }
      const db = openDb(dbPath);
      try {
        return await tick(db, config, runtime, logger, { ...opts, activeDestinations: usable });
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
          tickFn: localTickFn,
          runtime,
          flushRemote: (request) => flushViaGateway(request, callGatewayFromThisProcess),
          doctorRemote: (request) => doctorViaGateway(request, callGatewayFromThisProcess),
        });
      },
      { commands: ["notify"] },
    );

    // What the CLI asks of the running Gateway (see src/gateway.ts): here every
    // installed channel can be reached and the model keys are available. Older
    // OpenClaw has no plugin Gateway methods; the CLI then works in its own process.
    const gateway = api as unknown as {
      registerGatewayMethod?: (
        name: string,
        handler: (request: {
          params?: unknown;
          respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
        }) => Promise<void> | void,
        opts?: { scope?: string },
      ) => void;
    };
    if (typeof gateway.registerGatewayMethod === "function") {
      const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
      gateway.registerGatewayMethod(
        FLUSH_METHOD,
        async ({ params, respond }) => {
          let request: SendOptions;
          try {
            request = parseFlushRequest(params, Object.keys(config.destinations));
          } catch (err) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: words(err) });
            return;
          }
          try {
            const result = await tickFn(request);
            const reply: FlushReply = result ? { result } : {};
            respond(true, reply, undefined);
          } catch (err) {
            respond(false, undefined, { code: "UNAVAILABLE", message: words(err) });
          }
        },
        { scope: "operator.write" },
      );
      gateway.registerGatewayMethod(
        DOCTOR_METHOD,
        async ({ params, respond }) => {
          try {
            const skipLlm = Boolean(params && typeof params === "object" && (params as { skipLlm?: unknown }).skipLlm === true);
            respond(true, await runDoctor({ dbPath, config, runtime, skipLlm }), undefined);
          } catch (err) {
            respond(false, undefined, { code: "UNAVAILABLE", message: words(err) });
          }
        },
        // write, not read: the model probe spends a few tokens.
        { scope: "operator.write" },
      );
    }

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
          tickFn: async () => { await tickFn({ force: false }); },
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
