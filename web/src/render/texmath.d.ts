declare module "markdown-it-texmath" {
  import type { MarkdownIt } from "markdown-it";
  const texmath: (
    md: MarkdownIt,
    options: {
      engine: { renderToString(tex: string, options: unknown): string };
      delimiters: string;
    },
  ) => void;
  export default texmath;
}
