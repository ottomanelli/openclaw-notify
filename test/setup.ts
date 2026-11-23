import { vi } from "vitest";

// No test may reach a real Gateway. On a machine that runs OpenClaw, the real client
// would connect to it, and `notify send` in a test would flush that machine's queue.
// Here every call fails the way it does on an OpenClaw with no client for plugins, so
// the CLI falls back to working in its own process.
vi.mock("../src/gateway-client.js", () => ({
  callGatewayFromThisProcess: vi.fn(async () => {
    const err = new Error("this OpenClaw has no Gateway client for plugins");
    err.name = "NoGatewayClient";
    throw err;
  }),
}));
