// @vitest-environment jsdom
//
// Model-based simulation of several complete clients (real CodeMirror
// editor, decorations, panel, both docs — wired as main.ts wires them)
// over an adversarial network (sim.ts). Unit tests check each module in
// isolation; this checks the invariants that only exist *between* modules
// and peers, the class of bug unit tests missed in phase 4 (an accepted
// suggestion changed Loro but not the editor, after which keystrokes were
// silently dropped or landed at the wrong offset):
//
// - after every step, each peer's editor shows exactly its Loro text;
// - nothing ever fails silently: CodeMirror swallows exceptions thrown by
//   update listeners and only logs them (that's how dropped edits stayed
//   silent), and Loro swallows exceptions thrown by subscribers — commit()
//   and import() return normally, the error only resurfaces later as an
//   unhandled promise rejection. Both are captured and fail the case;
// - once every message is delivered, all peers converge: same text, same
//   annotations with the same resolved ranges and statuses;
// - decisions mean what the journal says (docs/adr/0013-*.md): at every
//   step, at every peer, a suggestion's decided status is the decision of
//   the first proposal journaled for it — never a later, losing one — and
//   once everything is delivered, every decided suggestion is applied
//   everywhere;
// - a restore (phase 7b), made through the peer's own history view, gives
//   that peer the version's text at once and changes nothing else — no
//   annotation, no decision —; like any edit, it then converges with
//   what was concurrent to it (edits, decisions applied later);
// - the shared index is never stale (docs/phase-4ter-*.md, decision 2):
//   after every step, each peer's index equals a fresh computation, and
//   its panel shows the fresh annotations (ids, order, statuses) and at
//   least every fresh conflict — a local erase may only *remove* a
//   crossing, and local edits don't re-render (a keystroke resolves
//   nothing), so a conflict shown a little longer is expected, a missing
//   one is a bug;
// - replies converge and are never lost (ADR-0035 §5): at every step, a
//   reply a peer holds stays, in the same relative order, unless its
//   annotation is erased; peers holding the same annotations show the same
//   threads; once everything is delivered, every reply written to an
//   annotation that still exists is in every peer's thread.
import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  type Decision,
  computeAnnotationsView,
  decodeProposal,
  listAnnotations,
  replyToAnnotation,
  suggestAddition,
  tryCreateAnnotation,
} from "../../lib/src/annotations/index.js";
import {
  describeFreshDecorations,
  describeShownDecorations,
} from "../editor/annotation-decorations.js";
import { textAt } from "../history/index.js";
import { createAnnotationsPanel } from "../ui/annotations/annotations-panel.js";
import { HistoryModel } from "../ui/history/history-model.js";
import { type SimPeer, Simulation, annotationsOf, contentOf } from "./sim.js";

const ALPHABET = "ab \n";
const OPERATIONS = [
  "type",
  "erase",
  "suggestAddition",
  "mark",
  "decide",
  "decide",
  "decideConcurrently",
  "reply",
  "replyConcurrently",
  "vandalize",
  "restore",
  "journal",
  "journal",
  "confirm",
  "confirm",
  "deliver",
  "deliver",
  "deliver",
] as const;

function drawText(tc: TestCase): string {
  return tc.draw(gs.text({ minSize: 1, maxSize: 4, alphabet: ALPHABET }));
}

function drawRange(tc: TestCase, peer: SimPeer): { from: number; to: number } {
  const length = peer.editor.view.state.doc.length;
  const from = tc.draw(gs.integers({ minValue: 0, maxValue: length }));
  const to = tc.draw(gs.integers({ minValue: from, maxValue: length }));
  return { from, to };
}

/** Decides through the peer's panel, as a user does: the panel must offer
 * the button (it shows the annotation open and undecided by this peer). */
function click(
  peer: SimPeer,
  id: string,
  action: "accept" | "reject" | "resolve",
): void {
  const button = peer.panel.querySelector<HTMLButtonElement>(
    `.annotation-item[data-id="${id}"] button[data-action="${action}"]`,
  );
  if (!button) {
    throw new Error(`peer${peer.index}'s panel offers no ${action} for ${id}`);
  }
  button.click();
}

function step(
  tc: TestCase,
  sim: Simulation,
): { description: string; typist?: SimPeer } {
  const operation = tc.draw(gs.sampledFrom(OPERATIONS));
  const description = act(tc, sim, operation);
  return operation === "type" || operation === "erase"
    ? { description, typist: sim.peers[lastPeer] }
    : { description };
}

let lastPeer = 0;

/** Every reply written in the case, by its text (unique): its annotation. */
const written = new Map<string, string>();

/** Replies to an annotation the peer sees, open or closed (a reply after
 * a decision is no fault, ADR-0035 §4). */
function reply(tc: TestCase, peer: SimPeer, id: string): string {
  const body = `r${written.size}`;
  written.set(body, id);
  replyToAnnotation(peer.annotationsDoc, id, {
    author: `peer${peer.index}`,
    body,
    createdAt: 0,
  });
  return `peer${peer.index} replies ${body} to ${id}`;
}

function act(
  tc: TestCase,
  sim: Simulation,
  operation: (typeof OPERATIONS)[number],
): string {
  const peer = tc.draw(gs.sampledFrom(sim.peers));
  lastPeer = peer.index;
  const { view } = peer.editor;
  switch (operation) {
    case "type": {
      const { from } = drawRange(tc, peer);
      const insert = drawText(tc);
      view.dispatch({ changes: { from, insert } });
      return `peer${peer.index} types ${JSON.stringify(insert)} at ${from}`;
    }
    case "erase": {
      const { from, to } = drawRange(tc, peer);
      if (from === to) return "noop";
      view.dispatch({ changes: { from, to } });
      return `peer${peer.index} erases [${from},${to})`;
    }
    case "suggestAddition": {
      const { from } = drawRange(tc, peer);
      const text = drawText(tc);
      suggestAddition(peer.contentDoc, peer.annotationsDoc, {
        at: from,
        text,
        author: `peer${peer.index}`,
      });
      return `peer${peer.index} suggests adding ${JSON.stringify(text)} at ${from}`;
    }
    case "mark": {
      const type = tc.draw(
        gs.sampledFrom(["deletion", "substitution", "comment"] as const),
      );
      const { from, to } = drawRange(tc, peer);
      if (type !== "comment" && from === to) return "noop";
      const result = tryCreateAnnotation(peer.contentDoc, peer.annotationsDoc, {
        type,
        start: from,
        end: to,
        author: `peer${peer.index}`,
        ...(type === "substitution" ? { replacement: drawText(tc) } : {}),
        ...(type === "comment" ? { body: "c" } : {}),
      });
      return `peer${peer.index} marks ${type} [${from},${to}) -> ${result.ok ? "ok" : "refused"}`;
    }
    case "decide": {
      // What the panel offers: an open annotation this peer hasn't
      // already proposed a decision for.
      const open = listAnnotations(peer.contentDoc, peer.annotationsDoc).filter(
        (a) => a.status === "open" && !peer.decisions.outcome(a.id),
      );
      if (open.length === 0) return "noop";
      const target = tc.draw(gs.sampledFrom(open));
      if (target.type === "comment") {
        click(peer, target.id, "resolve");
        return `peer${peer.index} resolves ${target.id}`;
      }
      const decision = tc.draw(gs.sampledFrom(["accept", "reject"] as const));
      click(peer, target.id, decision);
      return `peer${peer.index} proposes ${decision} for ${target.type} ${target.id}`;
    }
    case "decideConcurrently": {
      // Every peer that sees the same suggestion open decides it, each
      // unaware of the others: the situation of ADR-0013's table.
      const candidates = listAnnotations(peer.contentDoc, peer.annotationsDoc)
        .filter((a) => a.type !== "comment" && a.status === "open")
        .map((a) => a.id);
      if (candidates.length === 0) return "noop";
      const id = tc.draw(gs.sampledFrom(candidates));
      const moves: string[] = [];
      for (const other of sim.peers) {
        const seen = listAnnotations(
          other.contentDoc,
          other.annotationsDoc,
        ).find((a) => a.id === id);
        if (seen?.status !== "open" || other.decisions.outcome(id)) continue;
        const decision = tc.draw(gs.sampledFrom(["accept", "reject"] as const));
        click(other, id, decision);
        moves.push(`peer${other.index} ${decision}`);
      }
      return `concurrently on ${id}: ${moves.join(", ")}`;
    }
    case "reply": {
      const seen = listAnnotations(peer.contentDoc, peer.annotationsDoc);
      if (seen.length === 0) return "noop";
      return reply(tc, peer, tc.draw(gs.sampledFrom(seen)).id);
    }
    case "replyConcurrently": {
      // Every peer that sees the annotation replies, each unaware of the
      // others' replies.
      const seen = listAnnotations(peer.contentDoc, peer.annotationsDoc);
      if (seen.length === 0) return "noop";
      const id = tc.draw(gs.sampledFrom(seen)).id;
      const moves: string[] = [];
      for (const other of sim.peers) {
        if (other.annotationsDoc.getMap("annotations").get(id) === undefined)
          continue;
        moves.push(reply(tc, other, id));
      }
      return `concurrently: ${moves.join(", ")}`;
    }
    case "vandalize": {
      // A reviewer erases an annotation's entry, replies and all
      // (ADR-0009: an accepted limit).
      const ids = [...peer.annotationsDoc.getMap("annotations").keys()];
      if (ids.length === 0) return "noop";
      const id = tc.draw(gs.sampledFrom(ids));
      peer.annotationsDoc.getMap("annotations").delete(id);
      peer.annotationsDoc.commit();
      return `peer${peer.index} erases the entry of ${id}`;
    }
    case "restore": {
      // No new operation: reading the history's tables creates their root
      // maps, empty, in toJSON — not a write.
      const annotationsOps = () =>
        JSON.stringify([...peer.annotationsDoc.oplogVersion().toJSON()]);
      const before = {
        annotations: annotationsOps(),
        log: peer.log.version,
        outbox: peer.outbox.length,
      };
      peer.history.show();
      const rows = Array.from(
        peer.historyParent.querySelectorAll<HTMLButtonElement>(
          ".history-entry:not(.named)",
        ),
      );
      const past = rows.filter((row) => !row.querySelector(".history-current"));
      if (past.length === 0) {
        peer.history.hide();
        return "noop";
      }
      const chosen = tc.draw(gs.sampledFrom(past));
      // The row's version, from the view's own model (rows keep its order).
      const groups = new HistoryModel(peer.contentDoc, peer.annotationsDoc)
        .entries()
        .filter((entry) => entry.kind === "group");
      const version = groups[rows.indexOf(chosen)];
      if (!version) throw new Error("a row with no version");
      const wanted = textAt(peer.contentDoc, version.frontiers);
      chosen.click();
      const button = Array.from(
        peer.historyParent.querySelectorAll("button"),
      ).find((element) => element.textContent === "Put this text back");
      if (!button) throw new Error(`peer${peer.index} offers no restore`);
      button.click();
      peer.history.hide();
      if (contentOf(peer) !== wanted) {
        throw new Error(
          `peer${peer.index} restored ${JSON.stringify(contentOf(peer))}, the version is ${JSON.stringify(wanted)}`,
        );
      }
      const after = {
        annotations: annotationsOps(),
        log: peer.log.version,
        outbox: peer.outbox.length,
      };
      if (
        after.annotations !== before.annotations ||
        after.log !== before.log ||
        after.outbox !== before.outbox
      ) {
        throw new Error(
          `peer${peer.index}'s restore changed more than the text:\nbefore ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`,
        );
      }
      return `peer${peer.index} restores ${JSON.stringify(chosen.textContent)} -> ${JSON.stringify(contentOf(peer))}`;
    }
    case "journal": {
      if (!sim.journalNext(peer.index)) return "noop";
      return `server journals peer${peer.index}'s proposal as seq ${sim.journal.length}`;
    }
    case "confirm": {
      if (peer.confirmed === sim.journal.length) return "noop";
      const upTo = tc.draw(
        gs.integers({
          minValue: peer.confirmed + 1,
          maxValue: sim.journal.length,
        }),
      );
      sim.confirm(peer.index, upTo);
      return `peer${peer.index} confirms the journal up to seq ${upTo}`;
    }
    case "deliver": {
      const pending = sim.pendingFor(peer.index);
      if (pending.length === 0) return "noop";
      const index = tc.draw(gs.sampledFrom(pending));
      sim.deliver(peer.index, index);
      const message = sim.messages[index];
      return `peer${peer.index} receives ${message?.channel} update #${index} from peer${message?.from}`;
    }
  }
}

/** Each peer's threads, by annotation id. */
function threads(sim: Simulation): Map<string, string[]>[] {
  return sim.peers.map(
    (peer) =>
      new Map(
        listAnnotations(peer.contentDoc, peer.annotationsDoc).map((a) => [
          a.id,
          a.replies.map((r) => r.body),
        ]),
      ),
  );
}

const isSubsequence = (part: string[], whole: string[]) => {
  let at = 0;
  for (const item of whole) if (item === part[at]) at++;
  return at === part.length;
};

/** ADR-0035 §5, at every step: what a peer held stays, in order, unless
 * the annotation is gone; two peers holding the same annotations show the
 * same threads. */
function assertRepliesKept(
  sim: Simulation,
  before: Map<string, string[]>[],
  trace: string[],
): Map<string, string[]>[] {
  const now = threads(sim);
  for (const peer of sim.peers) {
    for (const [id, was] of before[peer.index] ?? []) {
      const is = now[peer.index]?.get(id);
      if (is && !isSubsequence(was, is)) {
        throw new Error(
          `peer${peer.index} lost replies to ${id}: had ${JSON.stringify(was)}, has ${JSON.stringify(is)}\n${trace.join("\n")}`,
        );
      }
    }
  }
  const held = (peer: SimPeer) =>
    JSON.stringify([...peer.annotationsDoc.oplogVersion().toJSON()].sort());
  for (const peer of sim.peers) {
    for (const other of sim.peers) {
      if (other.index <= peer.index || held(peer) !== held(other)) continue;
      const a = JSON.stringify([...(now[peer.index] ?? [])]);
      const b = JSON.stringify([...(now[other.index] ?? [])]);
      if (a !== b) {
        throw new Error(
          `peer${peer.index} and peer${other.index} hold the same annotations but show different threads:\n${a}\n${b}\n${trace.join("\n")}`,
        );
      }
    }
  }
  return now;
}

/** Once everything is delivered: every reply written to an annotation
 * that still exists is in every peer's thread. */
function assertNoReplyLost(sim: Simulation, trace: string[]): void {
  for (const [index, shown] of threads(sim).entries()) {
    for (const [body, id] of written) {
      const thread = shown.get(id);
      if (thread && !thread.includes(body)) {
        throw new Error(
          `peer${index} lost reply ${body} to ${id}: ${JSON.stringify(thread)}\n${trace.join("\n")}`,
        );
      }
    }
  }
}

/** The decision of the first proposal journaled for each annotation. */
function journalWinners(sim: Simulation): Map<string, Decision> {
  const winners = new Map<string, Decision>();
  for (const record of sim.journal) {
    const proposal = decodeProposal(record);
    if (proposal && !winners.has(proposal.annotationId)) {
      winners.set(proposal.annotationId, proposal.decision);
    }
  }
  return winners;
}

const STATUS_OF: Record<Decision, string> = {
  accept: "accepted",
  reject: "rejected",
  resolve: "resolved",
};

function assertDecisionsFollowTheJournal(
  sim: Simulation,
  trace: string[],
  settled: boolean,
): void {
  const winners = journalWinners(sim);
  for (const peer of sim.peers) {
    for (const a of listAnnotations(peer.contentDoc, peer.annotationsDoc)) {
      if (a.type === "comment") continue;
      const winner = winners.get(a.id);
      const expected = winner ? STATUS_OF[winner] : "open";
      const ok = settled
        ? a.status === expected
        : a.status === "open" || a.status === expected;
      if (!ok) {
        throw new Error(
          `peer${peer.index} shows ${a.type} ${a.id} as ${a.status}, the journal says ${expected}\n${trace.join("\n")}`,
        );
      }
    }
  }
}

function assertEditorsMatchLoro(sim: Simulation, trace: string[]): void {
  for (const peer of sim.peers) {
    const shown = peer.editor.view.state.doc.toString();
    const stored = contentOf(peer);
    if (shown !== stored) {
      throw new Error(
        `peer${peer.index}'s editor shows ${JSON.stringify(shown)} but its Loro text is ${JSON.stringify(stored)}\n${trace.join("\n")}`,
      );
    }
  }
}

/** What, of a peer's state, notifies its index when it changes: its
 * docs' *state* — an import that changes no state (an operation already
 * superseded, a duplicate) emits no Loro event, and needs no rendering —
 * and its confirmed log. */
function notifyingState(peer: SimPeer): {
  annotations: string;
  content: string;
  log: number;
} {
  return {
    // The annotations only: the history's tables notify no one (phase
    // 7b), and reading them creates their empty root maps in toJSON.
    annotations: JSON.stringify(
      peer.annotationsDoc.getMap("annotations").toJSON(),
    ),
    content: contentOf(peer),
    log: peer.log.version,
  };
}

/** Peers whose views must now be exactly fresh: something that notifies
 * their index happened during the step — the state of their annotations
 * or their confirmed log changed, or their text changed other than by
 * their own typing. */
function notifiedPeers(
  sim: Simulation,
  before: ReturnType<typeof notifyingState>[],
  typist: SimPeer | undefined,
): SimPeer[] {
  return sim.peers.filter((peer) => {
    const was = before[peer.index];
    const now = notifyingState(peer);
    return (
      !was ||
      was.annotations !== now.annotations ||
      was.log !== now.log ||
      (was.content !== now.content && peer !== typist)
    );
  });
}

/** Exactly fresh: the panel equals a new panel rendered now, and the
 * decorations equal a rebuild. */
function assertRenderedExactly(peers: SimPeer[], trace: string[]): void {
  for (const peer of peers) {
    const fresh = document.createElement("div");
    const freshPanel = createAnnotationsPanel(
      fresh,
      peer.editor,
      peer.annotationIndex,
      () => `peer${peer.index}`,
      peer.decisions,
      () => {},
      "edit",
      undefined,
      undefined,
      undefined,
      undefined,
      { index: peer.awaiting, setAside: peer.setAside },
    );
    for (const part of [".annotations-list", ".conflicts-panel"]) {
      const shown = peer.panel.querySelector(part)?.innerHTML;
      const expected = fresh.querySelector(part)?.innerHTML;
      if (shown !== expected) {
        throw new Error(
          `peer${peer.index}'s ${part} was not re-rendered:\nshown    ${shown}\nexpected ${expected}\n${trace.join("\n")}`,
        );
      }
    }
    freshPanel.destroy();
    const shown = describeShownDecorations(peer.editor.view);
    const expected = describeFreshDecorations(peer.annotationIndex);
    if (JSON.stringify(shown) !== JSON.stringify(expected)) {
      throw new Error(
        `peer${peer.index}'s decorations were not rebuilt:\nshown    ${JSON.stringify(shown)}\nexpected ${JSON.stringify(expected)}\n${trace.join("\n")}`,
      );
    }
  }
}

function assertViewsAreFresh(sim: Simulation, trace: string[]): void {
  for (const peer of sim.peers) {
    const fail = (what: string, shown: unknown, fresh: unknown) => {
      throw new Error(
        `peer${peer.index}'s ${what} is stale: shows ${JSON.stringify(shown)}, fresh ${JSON.stringify(fresh)}\n${trace.join("\n")}`,
      );
    };
    const fresh = computeAnnotationsView(peer.contentDoc, peer.annotationsDoc);
    const indexed = peer.annotationIndex.current();
    const comparable = (view: typeof fresh) =>
      JSON.stringify([view.annotations, view.conflicts]);
    if (comparable(indexed) !== comparable(fresh)) {
      fail("index", comparable(indexed), comparable(fresh));
    }

    // Every card shown, open and closed (ADR-0052 §1): the filter stays
    // on « All » once chosen.
    peer.panel
      .querySelector<HTMLButtonElement>(
        '.annotations-filter [data-filter="all"]',
      )
      ?.click();
    const items = Array.from(
      peer.panel.querySelectorAll<HTMLElement>(".annotation-item"),
    );
    const shownIds = items.map((item) => item.dataset.id);
    // Open ones first, then closed ones, each in creation order (phase
    // 10c).
    const freshIds = [
      ...fresh.annotations.filter((a) => a.status === "open"),
      ...fresh.annotations.filter((a) => a.status !== "open"),
    ].map((a) => a.id);
    if (JSON.stringify(shownIds) !== JSON.stringify(freshIds)) {
      fail("panel list", shownIds, freshIds);
    }
    for (const a of fresh.annotations) {
      const item = items.find((candidate) => candidate.dataset.id === a.id);
      const state = item?.dataset.state;
      const outcome = peer.decisions.outcome(a.id);
      // A confirmed decision not applied yet (phase 5): every simulated
      // peer is an editor, so it waits for the text its change depends on.
      const confirmed =
        a.status === "open"
          ? peer.decisions.confirmed(
              a.id,
              a.type === "comment" ? "comment" : "suggestion",
            )
          : undefined;
      const expected = confirmed
        ? `confirmed-${confirmed.decision}`
        : a.status === "open" && outcome?.kind === "pending"
          ? `pending-${outcome.decision}`
          : a.status;
      if (state !== expected) fail(`state of ${a.id}`, state, expected);
    }

    // Each crossing pair is said on both cards (phase 10c).
    const crosses = (id: string, other: string) =>
      (items.find((item) => item.dataset.id === id)?.dataset.conflicts ?? "")
        .split(" ")
        .includes(other);
    for (const { a, b } of fresh.conflicts) {
      if (!crosses(a, b) || !crosses(b, a)) {
        fail("conflicts on the cards", [a, b], fresh.conflicts);
      }
    }
  }
}

describe("multi-peer simulation (model-based property)", () => {
  let errors: unknown[];
  let nextId = 0;
  const onRejection = (reason: unknown) => {
    errors.push(reason);
  };
  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      // Hegel prints the draws of a failing case's final replay there.
      if (typeof args[0] === "string" && args[0].startsWith("var draw_")) {
        return;
      }
      errors.push(args);
    });
    // Annotation ids feed the order annotations are listed in, hence which
    // one a step picks: a random UUID would make generation
    // non-reproducible (Hegel can't replay or shrink a failure).
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    process.on("unhandledRejection", onRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", onRejection);
    vi.restoreAllMocks();
  });

  async function assertNothingFailedSilently(trace: string[]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `something failed silently: ${first instanceof Error ? first.stack : String(first)}\n${trace.join("\n")}`,
      );
    }
  }

  test(
    "editors never diverge from Loro, nothing logs an error, and all peers converge",
    () =>
      hegel.testAsync(async (tc) => {
        nextId = 0;
        errors.length = 0;
        written.clear();
        const sim = new Simulation(
          tc.draw(gs.integers({ minValue: 2, maxValue: 3 })),
        );
        const seed = tc.draw(
          gs.text({ minSize: 0, maxSize: 12, alphabet: ALPHABET }),
        );
        if (seed.length > 0) {
          sim.peers[0]?.editor.view.dispatch({
            changes: { from: 0, insert: seed },
          });
          sim.deliverAll();
        }
        const trace = [
          `seed ${JSON.stringify(seed)}, ${sim.peers.length} peers`,
        ];

        const stepCount = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
        let held = threads(sim);
        for (let i = 0; i < stepCount; i++) {
          const before = sim.peers.map(notifyingState);
          const { description, typist } = step(tc, sim);
          trace.push(description);
          assertEditorsMatchLoro(sim, trace);
          await assertNothingFailedSilently(trace);
          assertDecisionsFollowTheJournal(sim, trace, false);
          assertViewsAreFresh(sim, trace);
          assertRenderedExactly(notifiedPeers(sim, before, typist), trace);
          held = assertRepliesKept(sim, held, trace);
        }

        await sim.settle();
        trace.push("-- everything journaled, confirmed and delivered --");
        assertEditorsMatchLoro(sim, trace);
        await assertNothingFailedSilently(trace);
        assertDecisionsFollowTheJournal(sim, trace, true);
        assertViewsAreFresh(sim, trace);
        assertRepliesKept(sim, held, trace);
        assertNoReplyLost(sim, trace);

        const [first, ...others] = sim.peers;
        if (!first) throw new Error("no peers");
        for (const other of others) {
          if (contentOf(other) !== contentOf(first)) {
            throw new Error(
              `content diverged: peer0=${JSON.stringify(contentOf(first))} peer${other.index}=${JSON.stringify(contentOf(other))}\n${trace.join("\n")}`,
            );
          }
          const a = JSON.stringify(annotationsOf(first));
          const b = JSON.stringify(annotationsOf(other));
          if (a !== b) {
            throw new Error(
              `annotations diverged:\npeer0=${a}\npeer${other.index}=${b}\n${trace.join("\n")}`,
            );
          }
        }
      }),
    300_000,
  );
});
