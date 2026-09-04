import assert from "node:assert/strict";
import test from "node:test";
import * as http from "node:http";
import { chat, LlmConfig, streamChat } from "../src/llm/client";

const messages = [{ role: "user" as const, content: "test" }];

async function withServer(
  handler: http.RequestListener,
  run: (cfg: LlmConfig) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret", model: "test" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

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
