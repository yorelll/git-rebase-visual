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
