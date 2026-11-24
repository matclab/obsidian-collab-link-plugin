// @vitest-environment jsdom
//
// Replays scenario traces downloaded from the page (`?trace`):
//   npm run replay -- path/to/trace-A.json path/to/trace-B.json
// Writes a readable report next to each trace (`<file>.replay.txt`) and
// fails if the replay disagrees with the browser or breaks an invariant.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Trace } from "./format.js";
import { replayTrace } from "./replay.js";
import { formatReport, summary } from "./report.js";

const files = (process.env.TRACE_FILES ?? "").split(",").filter(Boolean);

describe.skipIf(files.length === 0)("replay of downloaded traces", () => {
  test.each(files)("%s", async (file) => {
    const trace = JSON.parse(readFileSync(file, "utf8")) as Trace;
    const report = await replayTrace(trace);
    writeFileSync(`${file}.replay.txt`, formatReport(trace, report));
    expect(
      report.divergences.length +
        report.violations.length +
        report.browserErrors.length +
        report.replayErrors.length +
        (report.finalDifference ? 1 : 0),
      `${summary(report)} — see ${file}.replay.txt`,
    ).toBe(0);
  });
});
