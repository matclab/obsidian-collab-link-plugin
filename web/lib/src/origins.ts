/** The Loro commit origin of what the user types in the editor (the page
 * commits its typing with it): derived models skip those commits, which
 * they already reflect (`annotations/annotation-index.ts`). A string, not
 * editor code: it lives here so that the library doesn't depend on the
 * editor. */
export const EDITOR_ORIGIN = "codemirror-editor";
