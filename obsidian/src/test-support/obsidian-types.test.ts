// The fake `obsidian` against Obsidian's types (`obsidian.d.ts`): each
// method it shares with the real API takes as many arguments as the real
// one can be given — a signature that grows in Obsidian shows here, at
// `tsc`, not as a test passing against a fake gone stale. The types of
// the arguments are left aside: the fake's classes are its own. Types
// only: nothing runs.
import type * as Real from "obsidian";
import { expectTypeOf, test } from "vitest";
import type * as Fake from "./obsidian.js";

type Fn = (...args: never[]) => unknown;
/** The methods of `F`, shared with `R`, that take fewer arguments. */
type Drift<F, R> = {
  [K in keyof F & keyof R]: F[K] extends Fn
    ? R[K] extends Fn
      ? [
          Exclude<Parameters<R[K]>["length"], Parameters<F[K]>["length"]>,
        ] extends [never]
        ? never
        : K
      : never
    : never;
}[keyof F & keyof R];

test("the fake's methods take as many arguments as Obsidian's", () => {
  expectTypeOf<Drift<Fake.Vault, Real.Vault>>().toBeNever();
  expectTypeOf<Drift<Fake.Workspace, Real.Workspace>>().toBeNever();
  expectTypeOf<Drift<Fake.WorkspaceLeaf, Real.WorkspaceLeaf>>().toBeNever();
  expectTypeOf<Drift<Fake.MetadataCache, Real.MetadataCache>>().toBeNever();
  expectTypeOf<Drift<Fake.FileManager, Real.FileManager>>().toBeNever();
  expectTypeOf<Drift<Fake.FileView, Real.FileView>>().toBeNever();
  expectTypeOf<Drift<Fake.MarkdownView, Real.MarkdownView>>().toBeNever();
  expectTypeOf<Drift<Fake.Plugin, Real.Plugin>>().toBeNever();
  expectTypeOf<Drift<Fake.Component, Real.Component>>().toBeNever();
  expectTypeOf<Drift<Fake.Modal, Real.Modal>>().toBeNever();
  expectTypeOf<
    Drift<Fake.SuggestModal<unknown>, Real.SuggestModal<unknown>>
  >().toBeNever();
  expectTypeOf<Drift<Fake.Setting, Real.Setting>>().toBeNever();
  expectTypeOf<Drift<Fake.Scope, Real.Scope>>().toBeNever();
  expectTypeOf<Drift<Fake.Keymap, Real.Keymap>>().toBeNever();
});
