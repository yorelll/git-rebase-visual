import type * as vscode from "vscode";

/**
 * Injection hook for the API key so the VSCode-provided path can be stubbed in
 * tests. Production should supply the real SecretStorage-backed implemention
 * once the key migration lands; until then the benign fallback below reports
 * "no secret stored" so callers degrade gracefully instead of crashing.
 */
export interface SecretsAccessor {
  readonly get: (key: string) => Promise<string | undefined>;
}

const fallback: SecretsAccessor = {
  get: async () => undefined,
};

let current: SecretsAccessor = fallback;

export const SecretsAccessModule = {
  get(): SecretsAccessor {
    return current;
  },
  set(accessor: SecretsAccessor): void {
    current = accessor;
  },
};

/**
 * Wraps a real `vscode.SecretStorage` into a `SecretsAccessor`. Safe to call
 * only from the extension host (integration), not from unit tests. `Thenable`
 * is normalized to `Promise` so callers can `await` uniformly.
 */
export function fromSecretStorage(secrets: vscode.SecretStorage): SecretsAccessor {
  return { get: async (key) => secrets.get(key) };
}
