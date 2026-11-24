import { type Trace, fromBase64 } from "./format.js";
import type { ReplayReport } from "./replay.js";

/** A readable timeline of a trace with the replay's findings inline. */
export function formatReport(trace: Trace, report: ReplayReport): string {
  const notes = new Map<number, string[]>();
  const note = (index: number, text: string) =>
    notes.set(index, [...(notes.get(index) ?? []), text]);
  for (const d of report.divergences) {
    note(d.index, `DIVERGENCE before this entry — ${d.difference}`);
  }
  for (const v of report.violations)
    note(v.index, `VIOLATION after — ${v.message}`);

  const lines = [
    `trace of ${trace.author}, document ${trace.documentId}, started ${new Date(trace.startedAt).toISOString()}, ${trace.entries.length} entries`,
    summary(report),
    "",
  ];
  trace.entries.forEach((entry, index) => {
    lines.push(`#${index} +${entry.at}ms ${describe(entry)}`);
    for (const text of notes.get(index) ?? []) lines.push(`    !! ${text}`);
  });
  if (report.finalDifference) {
    lines.push("", `FINAL STATE differs — ${report.finalDifference}`);
  }
  if (report.replayErrors.length > 0) {
    lines.push("", "errors raised during the replay:", ...report.replayErrors);
  }
  return lines.join("\n");
}

export function summary(report: ReplayReport): string {
  return [
    `${report.divergences.length} divergence(s)`,
    `${report.violations.length} violation(s)`,
    `${report.browserErrors.length} browser error(s)`,
    `${report.replayErrors.length} replay error(s)`,
    report.finalDifference ? "final state differs" : "final state matches",
  ].join(", ");
}

function describe(entry: Trace["entries"][number]): string {
  switch (entry.kind) {
    case "import":
      return `import ${entry.channel} (${fromBase64(entry.bytes).length} bytes)`;
    case "importBatch":
      return `import ${entry.channel}, ${entry.updates.length} updates at once`;
    case "confirm":
      return `confirm seq ${entry.batch.map((r) => r.seq).join(",")}: ${entry.batch
        .map((r) => new TextDecoder().decode(fromBase64(r.record)))
        .join(" ")}`;
    case "edit":
      return `edit (${entry.userEvent}) ${JSON.stringify(entry.changes)}`;
    case "create":
      return `create ${entry.type} [${entry.from},${entry.to})${entry.addAt === undefined ? "" : ` at ${entry.addAt}`} ${JSON.stringify(entry.extra)}`;
    case "propose":
      return `propose ${entry.decision} ${entry.id}`;
    case "resolve":
      return `resolve ${entry.id}`;
    case "reply":
      return `reply to ${entry.id}: ${JSON.stringify(entry.body)}`;
    case "published":
      return `published on ${entry.channel}: ${new TextDecoder().decode(fromBase64(entry.bytes))}`;
    case "error":
      return `ERROR in the browser: ${entry.message}`;
  }
}
