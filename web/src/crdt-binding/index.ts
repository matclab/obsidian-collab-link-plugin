export type { PositionalEdit, TextDiffOp } from "./binding.js";
export {
  applyChangesToString,
  applyEditorChangesToLoroText,
  loroDeltaToChangeSpec,
} from "./binding.js";

/** Commit origin tagging the Loro batches the editor produces itself
 * (`editor/editor.ts`): its own subscription tells them apart from every
 * other mutation, and so does the annotation index — a keystroke costs it
 * nothing, any other local write of the text is a change to show. Defined
 * by the library, which doesn't depend on the editor. */
export { EDITOR_ORIGIN } from "../../lib/src/index.js";
