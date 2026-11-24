import { t } from "../i18n/index.js";
import type { TraceRecorder } from "../trace/recorder.js";

/** A button that downloads the scenario trace as JSON (`trace/`). The file
 * holds the document in clear text: it never leaves the browser otherwise. */
export function attachTraceDownload(
  container: Element,
  recorder: TraceRecorder,
  author: string,
): void {
  const button = document.createElement("button");
  button.className = "trace-download";
  button.textContent = t().downloadTrace;
  button.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(recorder.toTrace())], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `trace-${author}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  container.appendChild(button);
}
