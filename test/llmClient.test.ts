import assert from "node:assert/strict";
import test from "node:test";
import * as http from "node:http";
import { chat, LlmConfig, streamChat } from "../src/llm/client";

const messages = [{ role: "user" as const, content: "test" }];

// Fetch deliberately blocks these ports to avoid cross-protocol attacks. Windows
// may allocate them from its dynamic range when a test listens on port 0.
const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
  515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 4333, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isFetchSafeTestPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && !fetchForbiddenPorts.has(port);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

async function listenOnFetchSafePort(server: http.Server): Promise<number> {
  // OS assignment remains useful for parallel test runs; inspect and retry if it
  // selected one of Fetch's forbidden ports before any client request is made.
  for (let attempt = 0; attempt < 64; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    if (isFetchSafeTestPort(address.port)) return address.port;
    await closeServer(server);
  }
  throw new Error("Unable to allocate a Fetch-safe test port.");
}

async function withServer(
  handler: http.RequestListener,
  run: (cfg: LlmConfig) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  const port = await listenOnFetchSafePort(server);
  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "secret", model: "test" });
  } finally {
    if (server.listening) await closeServer(server);
  }
}

test("LLM test server excludes Fetch forbidden ports", () => {
  assert.equal(isFetchSafeTestPort(6667), false);
  assert.equal(isFetchSafeTestPort(10080), false);
  assert.equal(isFetchSafeTestPort(18080), true);
});

test("streamChat yields SSE deltas and ignores malformed events", async () => {
  await withServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: {not json}\n\n");
    res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  }, async (cfg) => {
    const chunks: string[] = [];
    const result = await streamChat(cfg, messages, (chunk) => chunks.push(chunk));
    assert.equal(result, "hello world");
    assert.deepEqual(chunks, ["hello ", "world"]);
  });
});

test("LLM errors are categorized without exposing response bodies", async () => {
  await withServer((_, res) => {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("secret server response");
  }, async (cfg) => {
    await assert.rejects(
      () => chat(cfg, messages),
      (error: Error) =>
        /authentication failed/.test(error.message) && !error.message.includes("secret server response")
    );
  });
});

test("LLM requests honor configured deadlines", async () => {
  await withServer((_req, _res) => {
    // Leave the request open until the client deadline aborts it.
  }, async (cfg) => {
    await assert.rejects(() => chat(cfg, messages, { timeout: 20 }), /timed out/);
  });
});

test("LLM requests honor caller cancellation", async () => {
  await withServer((_req, _res) => {
    // Leave the request open until the caller cancels it.
  }, async (cfg) => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(() => chat(cfg, messages, { signal: controller.signal }), /cancelled by test/);
  });
});

test("streamChat mid-stream cancellation stops draining the response", async () => {
  const chunks: string[] = [];
  const controller = new AbortController();
  // Stream one delta then hold the connection open. The hardening races each
  // `reader.read()` against the abort signal, so the loop must stop promptly
  // (no further deltas) and surface the caller's abort reason.
  //
  // The abort fires from within the server handler, so the abort dispatch runs
  // in the streamChat flow (not from a detached timer that could surface the
  // rejection after the test body completes).
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    setTimeout(() => {
      res.end();
      // Abort listeners have already run by the time this returns; the abort
      // dispatch may rethrow one of their rejections, so seal it — the test
      // only asserts the stream rejects with the reason.
      try {
        controller.abort(new Error("user cancelled"));
      } catch {
        // ignore — the abort was already delivered to all listeners
      }
    }, 5);
  }, async (cfg) => {
    await assert.rejects(
      () => streamChat(cfg, messages, (c) => chunks.push(c), { signal: controller.signal }),
      /user cancelled/
    );
    // Let undici's response-body teardown settle inside the test so no async
    // activity outlives it (node:test reports it as post-test activity).
    await new Promise((r) => setTimeout(r, 20));
  });
  // Only the first delta arrived before cancellation.
  assert.deepEqual(chunks, ["partial"]);
});

test("streamChat honours the deadline mid-stream", async () => {
  const chunks: string[] = [];
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // The stream stays open, forcing the client deadline to fire mid-read.
  }, async (cfg) => {
    await assert.rejects(
      () => streamChat(cfg, messages, (c) => chunks.push(c), { timeout: 20 }),
      /timed out/
    );
  });
  assert.deepEqual(chunks, ["partial"]);
});
