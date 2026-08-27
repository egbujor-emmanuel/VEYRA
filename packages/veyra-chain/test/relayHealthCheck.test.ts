import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRelayHealth } from "../src/relayHealthCheck.js";

function fakeFetchOk(): typeof fetch {
  return (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
}

function fakeFetchHttpError(status: number): typeof fetch {
  return (async () => new Response("{}", { status })) as unknown as typeof fetch;
}

function fakeFetchThrows(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

test("a healthy relay reports healthy:true with a measured latency", async () => {
  const result = await checkRelayHealth({ relayUrl: "https://example.invalid/relay", fetchImpl: fakeFetchOk() });
  assert.equal(result.healthy, true);
  assert.equal(result.error, null);
  assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
});

test("an HTTP error response reports healthy:false with the status code as the reason", async () => {
  const result = await checkRelayHealth({ relayUrl: "https://example.invalid/relay", fetchImpl: fakeFetchHttpError(503) });
  assert.equal(result.healthy, false);
  assert.equal(result.error, "HTTP 503");
});

test("a network-level failure (e.g. unreachable) reports healthy:false with the underlying error message, and no latency", async () => {
  const result = await checkRelayHealth({ relayUrl: "https://example.invalid/relay", fetchImpl: fakeFetchThrows("fetch failed: ECONNREFUSED") });
  assert.equal(result.healthy, false);
  assert.equal(result.latencyMs, null);
  assert.ok(result.error?.includes("ECONNREFUSED"));
});

test("the request body is a minimal, side-effect-free JSON-RPC call -- no account/session data included", async () => {
  let capturedBody: string | null = null;
  const spyFetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await checkRelayHealth({ relayUrl: "https://example.invalid/relay", fetchImpl: spyFetch });
  const parsed = JSON.parse(capturedBody!);
  assert.equal(parsed.method, "web3_clientVersion");
  assert.deepEqual(parsed.params, []);
});
