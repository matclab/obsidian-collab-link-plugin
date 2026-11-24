/** An editor's credentials, for tests where the role isn't the point:
 * the fake servers accept any secret. */
export const EDITOR = {
  role: "edit" as const,
  secret: new Uint8Array(32),
};

/** A reader's credentials (ADR-0019 §1): it publishes nothing. */
export const READER = {
  role: "read" as const,
  secret: new Uint8Array(32),
};
