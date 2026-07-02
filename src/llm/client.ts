export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Batch (non-streaming) chat completion from an OpenAI-compatible endpoint.
 * Resolves with the full message text once the model has finished.
 */
export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.4,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as any;
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Streams a chat completion from an OpenAI-compatible endpoint. Invokes
 * `onDelta` for each content chunk and resolves with the full text. Uses the
 * global fetch available in Node 18+.
 */
export async function streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.4,
      stream: true,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
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
        // ignore malformed keep-alive lines
      }
    }
  }
  return full;
}
