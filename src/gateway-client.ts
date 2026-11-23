import type { GatewayCall } from "./gateway.js";

// The one place that talks to a real Gateway: OpenClaw's own CLI client, which finds
// the local Gateway and uses the credentials the CLI already has. Kept apart from
// gateway.ts so tests can replace this module whole and never reach a Gateway that
// happens to be running on the machine.

// This OpenClaw has no Gateway client a plugin can use (it predates the module below).
export class NoGatewayClient extends Error {
  constructor() {
    super("this OpenClaw has no Gateway client for plugins");
    this.name = "NoGatewayClient";
  }
}

// Named in a variable so the type checker and bundlers do not follow it: the plugin
// still loads on an OpenClaw from before this module existed.
const GATEWAY_CLIENT_MODULE = "openclaw/plugin-sdk/gateway-runtime";

type GatewayClientModule = {
  callGatewayFromCli?: (
    method: string,
    opts: { json?: boolean; timeout?: string },
    params?: unknown,
  ) => Promise<unknown>;
};

export const callGatewayFromThisProcess: GatewayCall = async (method, params, timeoutMs) => {
  let client: GatewayClientModule;
  try {
    client = (await import(GATEWAY_CLIENT_MODULE)) as GatewayClientModule;
  } catch {
    throw new NoGatewayClient();
  }
  if (typeof client.callGatewayFromCli !== "function") throw new NoGatewayClient();
  // json: no progress spinner on the terminal.
  return client.callGatewayFromCli(method, { json: true, timeout: String(timeoutMs) }, params);
};
