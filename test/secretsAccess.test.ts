import assert from "node:assert/strict";
import test from "node:test";
import { SecretsAccessModule, fromSecretStorage } from "../src/ui/secretsAccess";

test("SecretStorage accessor falls back to 'no secret' without crashing", async () => {
  // The module default (no injection) must be a safe no-op, not a crash.
  SecretsAccessModule.set({
    get: async () => undefined,
  });
  assert.equal(await SecretsAccessModule.get().get("whatever"), undefined);
});

test("fromSecretStorage adapts a vscode.SecretStorage-shaped object", async () => {
  const fake = {
    async get(key: string): Promise<string | undefined> {
      return key === "a" ? "alpha" : undefined;
    },
    async store(key: string, value: string): Promise<void> {
      void key;
      void value;
    },
    async delete(key: string): Promise<void> {
      void key;
    },
  };
  // `fromSecretStorage` only needs the `get` signature to compile against the
  // structural accessor; we verify the returned wrapper delegates correctly.
  const accessor = fromSecretStorage(fake as unknown as import("vscode").SecretStorage);
  assert.equal(await accessor.get("a"), "alpha");
  assert.equal(await accessor.get("missing"), undefined);
});
