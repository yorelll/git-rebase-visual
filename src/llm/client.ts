export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmRequestOptions {
  signal?: AbortSignal;
  /** Network deadline in milliseconds. Defaults to two minutes. */
  timeout?: number;
}

interface PendingRequest {
  response: Response;
  signal: AbortSignal;
  finish: () => void;
  isTimedOut: () => boolean;
}

const DEFAULT_TIMEOUT = 120_000;

async function startRequest(
  cfg: LlmConfig,
  messages: ChatMessage[],
  stream: boolean,
  options: LlmRequestOptions
): Promise<PendingRequest> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("LLM request timed out"));
  }, options.timeout ?? DEFAULT_TIMEOUT);
  const finish = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  try {
    const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.4,
        ...(stream ? { stream: true } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      finish();
      throw new Error(llmErrorMessage(response.status));
    }
    return { response, signal: controller.signal, finish, isTimedOut: () => timedOut };
  } catch (error) {
    finish();
    if (timedOut) {
      throw new Error("LLM request timed out. Please try again.");
    }
    if (controller.signal.aborted && options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    throw error;
  }
}

function throwIfTimedOut(pending: PendingRequest): void {
  if (pending.isTimedOut()) {
    throw new Error("LLM request timed out. Please try again.");
  }
}

function llmErrorMessage(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "LLM authentication failed. Check the configured API key.";
    case 429:
      return "LLM service is rate-limiting requests. Please try again later.";
    default:
      return status >= 500
        ? "LLM service is unavailable. Please try again later."
        : `LLM request failed (HTTP ${status}).`;
  }
}

/** Batch chat completion from an OpenAI-compatible endpoint. */
export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  options: LlmRequestOptions = {}
): Promise<string> {
  const pending = await startRequest(cfg, messages, false, options);
  try {
    const json = (await pending.response.json()) as any;
    throwIfTimedOut(pending);
    return (json.choices?.[0]?.message?.content ?? "").trim();
  } catch (error) {
    throwIfTimedOut(pending);
    throw error;
  } finally {
    pending.finish();
  }
}

/**
 * Creates a promise that resolves when the caller aborts or after `ms`.
 * Used to race the next SSE read against cancellation/timeout so a server that
 * stops sending data cannot leave `reader.read()` pending forever. Resolves
 * with a discriminant so the caller can distinguish an abort from a timeout.
 *
 * The abort is captured by each timer tick re-checking `signal.aborted`, which
 * is closed over and observed even when the abort races the listener
 * registration (no "unregistered abort" window, no stray timers keeping the
 * event loop alive).
 */
async function abortOrTimeout(
  options: LlmRequestOptions,
  cancelled?: AbortSignal
): Promise<{ kind: "abort"; reason: unknown } | { kind: "timeout"; cancelled: boolean }> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  if (options.signal?.aborted) {
    return { kind: "abort", reason: options.signal.reason };
  }
  return new Promise((resolve) => {
    // `cancelled` lets the read loop tear this pending race down when the
    // reader wins, so no stray timer keeps the event loop alive afterwards.
    const cleanup = () => {
      clearTimeout(timer);
      cancelled?.removeEventListener("abort", onCancelled);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (out: { kind: "abort"; reason: unknown } | { kind: "timeout"; cancelled: boolean }) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(out);
    };
    const timer = setTimeout(() => {
      finish({ kind: "timeout", cancelled: false });
    }, timeout);
    const onAbort = () => finish({ kind: "abort", reason: options.signal?.reason });
    const onCancelled = () => finish({ kind: "timeout", cancelled: true });
    let finished = false;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    cancelled?.addEventListener("abort", onCancelled, { once: true });
  });
}

/**
 * Streams an OpenAI-compatible chat completion. Invokes `onDelta` for each
 * content chunk and resolves with the complete generated text. Each SSE read
 * is raced against cancellation/deadline, so an idle connection cannot hang.
 */
export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  options: LlmRequestOptions = {}
): Promise<string> {
  const pending = await startRequest(cfg, messages, true, options);
  if (!pending.response.body) {
    pending.finish();
    throw new Error("LLM service returned an empty response.");
  }

  const reader = pending.response.body.getReader();
  const onAbort = () => {
    // The body may already be closing; swallow the cancel() rejection so an
    // in-flight abort never surfaces as an unhandled rejection.
    reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      // An egoist server that stops emitting bytes (no timeout configured)
      // would otherwise leave `reader.read()` pending indefinitely. Race each
      // read against cancellation/deadline; tear the losing race down when the
      // read wins so no stray timer outlives the loop.
      const raceController = new AbortController();
      // The abort listener also calls reader.cancel(), which rejects the
      // in-flight read. Absorb that rejection so the losing side never
      // surfaces as an unhandled rejection when the caller aborts mid-read.
      const read = reader.read().then((r) => {
        raceController.abort(); // read won — retire the abortOrTimeout timer
        return r;
      });
      read.catch(() => undefined); // discard the loser's rejection
      const anyRead = await Promise.race([
        read,
        abortOrTimeout(options, raceController.signal),
      ]);
      throwIfTimedOut(pending);
      if ("kind" in anyRead && anyRead.kind === "abort") {
        throw anyRead.reason instanceof Error
          ? anyRead.reason
          : new Error(String(anyRead.reason ?? "LLM request cancelled."));
      }
      if ("kind" in anyRead && anyRead.kind === "timeout") {
        if (anyRead.cancelled) {
          continue; // the read actually won; this was the torn-down race
        }
        throw new Error("LLM request timed out. Please try again.");
      }
      if (anyRead.done) {
        break;
      }
      buffer += decoder.decode(anyRead.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          return full;
        }
        try {
          const json = JSON.parse(data);
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // Ignore malformed keep-alive lines from otherwise valid SSE streams.
        }
      }
    }
    return full;
  } finally {
    pending.finish();
    options.signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
