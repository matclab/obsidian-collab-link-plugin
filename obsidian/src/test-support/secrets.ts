import type { SecretStore } from "../link-store.js";

/** `app.secretStorage`, as Obsidian 1.13 has it: no removal; an id is
 * lowercase letters, digits and dashes, 64 characters at most. */
export function fakeSecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    setSecret(id, secret) {
      if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`invalid id ${id}`);
      values.set(id, secret);
    },
    getSecret: (id) => values.get(id) ?? null,
    listSecrets: () => [...values.keys()],
  };
}
