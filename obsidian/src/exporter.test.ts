// The export's cases one by one (analysis 14c): what it says and when it
// writes; the scenario (`exporter.property.test.ts`) mixes them.
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { counter, resetCounters } from "../../web/lib/src/index.js";
import { EXPORT_DELAY_MS, NoteExporter, type Outside } from "./exporter.js";
import { formatVersion, writeHeader } from "./note-header.js";

/** A vault whose `process` runs at once. */
function vault(text: string) {
  const file = { text, writes: 0 };
  return {
    file,
    process: async (_: object, fn: (current: string) => string) => {
      const next = fn(file.text);
      if (next !== file.text) file.writes++;
      file.text = next;
      return next;
    },
  };
}

function setUp(initial: (doc: LoroDoc) => string) {
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  const store = vault(initial(doc));
  const onOutside = vi.fn<(outside: Outside) => void>();
  /** The copies kept, and the file as it was when each was asked for. */
  const copies: { text: string; fileThen: string }[] = [];
  /** What happens to the file while a copy is made. */
  const whileKeeping: { run?: () => void } = {};
  /** Told of each import from the server, as the view tells it. */
  const importers = new Set<() => void>();
  const receive = (bytes: Uint8Array) => {
    doc.import(bytes);
    for (const told of importers) told();
  };
  const exporter = new NoteExporter({
    doc,
    documentId: "doc",
    file: () => store.file,
    process: store.process,
    keep: async (text) => {
      copies.push({ text, fileThen: store.file.text });
      whileKeeping.run?.();
      return `Note (copy ${copies.length}).md`;
    },
    onOutside,
    imported: (told) => {
      importers.add(told);
      return () => importers.delete(told);
    },
  });
  const type = (text: string) => {
    const content = doc.getText("content");
    content.insert(content.length, text);
    doc.commit();
  };
  const exportOf = (from: LoroDoc) =>
    writeHeader(from.getText("content").toString(), {
      document: "doc",
      version: formatVersion(from.frontiers()),
    });
  return {
    doc,
    store,
    onOutside,
    copies,
    whileKeeping,
    exporter,
    type,
    exportOf,
    receive,
    importers,
  };
}

const fresh = (doc: LoroDoc) =>
  writeHeader(doc.getText("content").toString(), {
    document: "doc",
    version: formatVersion(doc.frontiers()),
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetCounters();
});
afterEach(() => vi.useRealTimers());

describe("the export", () => {
  test("goes out a second after the first change, however the typing goes on", async () => {
    const { store, exporter, type, doc, exportOf } = setUp(fresh);
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    const writes = store.file.writes;

    type("a");
    await vi.advanceTimersByTimeAsync(600);
    type("b");
    await vi.advanceTimersByTimeAsync(399);
    expect(store.file.writes).toBe(writes);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.file.text).toBe(exportOf(doc));
    expect(store.file.writes).toBe(writes + 1);
  });

  test("costs nothing per keystroke: one write for a burst of typing", async () => {
    const { exporter, type } = setUp(fresh);
    exporter.start();
    for (let i = 0; i < 50; i++) type("x");
    expect(counter("export.write")).toBe(0);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(counter("export.write")).toBe(1);
    // The file's version checked once, at the first write only.
    expect(counter("export.fork")).toBe(1);
  });

  test("a file changed from outside is kept in a copy first, then written over with the export; said, with its base", async () => {
    const { store, exporter, type, doc, onOutside, copies, exportOf } =
      setUp(fresh);
    exporter.start();
    type("a");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    const base = doc.frontiers();
    store.file.text = store.file.text.replace(/a$/, "a from outside");
    const changed = store.file.text;

    type("b");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    // ME1, ME2: kept before anything is written over it, without the
    // two properties.
    expect(copies).toEqual([{ text: "a from outside", fileThen: changed }]);
    expect(onOutside).toHaveBeenCalledExactlyOnceWith({
      copy: "Note (copy 1).md",
      text: "a from outside",
      base,
    });
    expect(store.file.text).toBe(exportOf(doc));
    // Not frozen: the export goes on (OI4).
    type("c");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(store.file.text).toBe(exportOf(doc));
    expect(copies).toHaveLength(1);
  });

  test("a change recognized (a rename's rewrite, phase 19): no copy, no message; handed over with the last export's base, then written over", async () => {
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    const store = vault(fresh(doc));
    const onOutside = vi.fn<(outside: Outside) => void>();
    const onRecognized = vi.fn<(outside: Outside) => void>();
    const copies: string[] = [];
    const exporter = new NoteExporter({
      doc,
      documentId: "doc",
      file: () => store.file,
      process: store.process,
      keep: async (text) => {
        copies.push(text);
        return "copy.md";
      },
      onOutside,
      recognize: (exported, found) =>
        found === exported.replace("[[C]]", "[[D]]"),
      onRecognized,
    });
    exporter.start();
    doc.getText("content").insert(0, "Vers [[C]].");
    doc.commit();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    const base = doc.frontiers();
    store.file.text = store.file.text.replace("[[C]]", "[[D]]");
    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(copies).toEqual([]);
    expect(onOutside).not.toHaveBeenCalled();
    expect(onRecognized).toHaveBeenCalledExactlyOnceWith({
      copy: "",
      text: "Vers [[D]].",
      base,
    });
    // Any other change still goes to a copy.
    store.file.text = store.file.text.replace("Vers", "Pour");
    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(copies).toHaveLength(1);
  });

  test("a change from outside is seen when Obsidian says the file changed, the document unchanged", async () => {
    const { store, exporter, doc, copies, exportOf } = setUp(fresh);
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    store.file.text += "from outside";

    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(copies).toHaveLength(1);
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("its own write, noticed, asks for nothing", async () => {
    const { store, exporter, type } = setUp(fresh);
    exporter.start();
    type("a");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    const reads = vi.spyOn(store, "process");

    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(reads).not.toHaveBeenCalled();
  });

  test("changed again while its copy was made, the file is kept again before being written over", async () => {
    const { store, exporter, type, doc, copies, whileKeeping, exportOf } =
      setUp(fresh);
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    store.file.text += "first";
    whileKeeping.run = () => {
      if (copies.length === 1) store.file.text += " then second";
    };

    type("x");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(copies.map(({ text }) => text)).toEqual([
      "first",
      "first then second",
    ]);
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("an export another device wrote, of a version this one holds, is written over without a copy — after the first write too", async () => {
    const other = new LoroDoc();
    other.setPeerId(2n);
    const { store, exporter, type, doc, copies, exportOf } = setUp(fresh);
    exporter.start();
    type("a");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    other.import(doc.export({ mode: "snapshot" }));
    other.getText("content").insert(0, "theirs ");
    other.commit();
    doc.import(other.export({ mode: "update" }));
    type("b");

    // The sync brings the other device's export (OW5).
    store.file.text = fresh(other);
    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(copies).toEqual([]);
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("its own export with the header reformatted is no change: no copy", async () => {
    const { store, exporter, type, doc, copies, exportOf } = setUp(fresh);
    exporter.start();
    type("a");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    store.file.text = store.file.text.replace(/"/g, "");

    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(copies).toEqual([]);
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("without a version it can read, the base is the last export's; before any, there is none", async () => {
    const first = setUp(() => "# a note\n");
    first.exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(first.onOutside).toHaveBeenCalledExactlyOnceWith({
      copy: "Note (copy 1).md",
      text: "# a note\n",
      base: undefined,
    });
    expect(first.store.file.text).toBe(first.exportOf(first.doc));

    const later = setUp(fresh);
    later.exporter.start();
    later.type("a");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    const base = later.doc.frontiers();
    later.store.file.text = "no header at all";
    later.type("b");
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(later.onOutside).toHaveBeenCalledExactlyOnceWith({
      copy: "Note (copy 1).md",
      text: "no header at all",
      base,
    });
  });

  test("a change from outside to a version this device lacks waits for it, then has it for base", async () => {
    const other = new LoroDoc();
    other.setPeerId(2n);
    other.getText("content").insert(0, "from the other device");
    other.commit();
    const { store, exporter, doc, onOutside, exportOf } = setUp(fresh);
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    store.file.text = fresh(other).replace("device", "device, edited");
    const changed = store.file.text;

    exporter.noticed(changed);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(onOutside).not.toHaveBeenCalled();
    expect(store.file.text).toBe(changed);

    doc.import(other.export({ mode: "snapshot" }));
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(onOutside).toHaveBeenCalledExactlyOnceWith({
      copy: "Note (copy 1).md",
      text: "from the other device, edited",
      base: other.frontiers(),
    });
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("an export of a version this device lacks waits for it, then is brought up to date", async () => {
    const other = new LoroDoc();
    other.setPeerId(2n);
    other.getText("content").insert(0, "from the other device");
    other.commit();
    const { store, exporter, doc, onOutside, exportOf } = setUp(() =>
      fresh(other),
    );
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(store.file.text).toBe(fresh(other));

    doc.import(other.export({ mode: "snapshot" }));
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);

    expect(onOutside).not.toHaveBeenCalled();
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("a change from outside to a version this device lacks, its operations leaving the text as it was: kept once they arrive", async () => {
    const other = new LoroDoc();
    other.setPeerId(2n);
    const text = other.getText("content");
    text.insert(0, "!");
    text.delete(0, 1);
    other.commit();
    const { store, exporter, doc, onOutside, exportOf, receive, importers } =
      setUp(fresh);
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    store.file.text = writeHeader("from outside", {
      document: "doc",
      version: formatVersion(other.frontiers()),
    });
    exporter.noticed(store.file.text);
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(onOutside).not.toHaveBeenCalled();

    // No event of Loro's: the text is the same.
    receive(other.export({ mode: "snapshot" }));
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(onOutside).toHaveBeenCalledExactlyOnceWith({
      copy: "Note (copy 1).md",
      text: "from outside",
      base: other.frontiers(),
    });
    expect(store.file.text).toBe(exportOf(doc));

    // Stopped: no longer told.
    await exporter.stop();
    expect(importers.size).toBe(0);
  });

  test("an older export of this document is brought up to date at opening", async () => {
    const { store, exporter, type, doc, exportOf, onOutside } = setUp((d) => {
      d.getText("content").insert(0, "old");
      d.commit();
      return fresh(d);
    });
    type(" and new");
    exporter.start();
    await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
    expect(onOutside).not.toHaveBeenCalled();
    expect(store.file.text).toBe(exportOf(doc));
  });

  test("another document's file, or one without the header, is from outside", async () => {
    for (const text of [
      "# a note\n",
      fresh(new LoroDoc()).replace('"doc"', '"x"'),
    ]) {
      const { store, exporter, onOutside, copies } = setUp(() => text);
      exporter.start();
      await vi.advanceTimersByTimeAsync(EXPORT_DELAY_MS);
      expect(onOutside).toHaveBeenCalledOnce();
      expect(copies[0]?.fileThen).toBe(text);
    }
  });

  test("closed, the last change is written at once, and nothing after", async () => {
    const { store, exporter, type, doc, exportOf } = setUp(fresh);
    exporter.start();
    type("last words");
    await exporter.close();
    expect(store.file.text).toBe(exportOf(doc));

    const closed = store.file.text;
    type("after");
    await vi.advanceTimersByTimeAsync(5 * EXPORT_DELAY_MS);
    expect(store.file.text).toBe(closed);
  });
});
