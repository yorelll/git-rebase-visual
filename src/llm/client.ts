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
 * Streams an OpenAI-compatible chat completion. Invokes `onDelta` for each
 * content chunk and resolves with the complete generated text.
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
  const onAbort = () => void reader.cancel(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      throwIfTimedOut(pending);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
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
    reader.releaseLock();
  }
}
