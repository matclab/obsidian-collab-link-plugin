// The images of a view (ADR-0057 §8), an actor of its own: what it awaits
// — the copy kept on the device, the download, the decryption, the copy
// written — ends in an order the test draws, and the view closes at any
// step (AGENTS.md §1.6). At each step: an address is either an image's
// shown one or revoked, all of them once closed, none made after; an
// image is downloaded at most once, and not at all if kept; a state only
// leaves `loading`, to what its answers say; listeners hear each change,
// at most once a microtask.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import type { OpenedImage } from "../../lib/src/index.js";
import {
  type AttachedImageSources,
  type AttachedState,
  createAttachedImages,
} from "./attached-images.js";

type Answer = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

interface Pending {
  what: string;
  id: string;
  answer: Answer;
}

const IDS = ["a", "b", "c"];

describe("the images of a view", () => {
  test("whatever ends first, and whenever the view closes", () =>
    hegel.testAsync(async (tc) => {
      const pending: Pending[] = [];
      const ask = <T>(what: string, id: string) =>
        new Promise<T>((resolve, reject) => {
          pending.push({
            what,
            id,
            answer: { resolve: resolve as (v: unknown) => void, reject },
          });
        });
      // What the device keeps and the server has, drawn per image.
      const kept = new Map<string, "good" | "bad" | undefined>();
      const served = new Map<string, "good" | "bad" | "absent" | "offline">();
      for (const id of IDS) {
        kept.set(
          id,
          tc.draw(
            gs.sampledFrom<"good" | "bad" | undefined>([
              "good",
              "bad",
              undefined,
            ]),
          ),
        );
        served.set(
          id,
          tc.draw(
            gs.sampledFrom<"good" | "bad" | "absent" | "offline">([
              "good",
              "bad",
              "absent",
              "offline",
            ]),
          ),
        );
      }
      const downloads = new Map<string, number>();
      const made = new Set<string>();
      const revoked = new Set<string>();
      let urls = 0;
      let closed = false;
      const late: number[] = [];
      const sources: AttachedImageSources = {
        cached: (id) => ask("cached", id),
        keep: (id) => ask("keep", id),
        download: (id) => {
          downloads.set(id, (downloads.get(id) ?? 0) + 1);
          return ask("download", id);
        },
        open: (id, blob) =>
          ask("open", `${id}:${new TextDecoder().decode(blob)}`),
        url: () => {
          // Recorded, not thrown: the service would catch it.
          if (closed) late.push(urls);
          const url = `blob:${urls++}`;
          made.add(url);
          return url;
        },
        revoke: (url) => {
          expect(made.has(url), "revoked what was never made").toBe(true);
          revoked.add(url);
        },
      };
      const images = createAttachedImages(sources);
      const heard: string[] = [];
      let notifications = 0;
      images.subscribe((ids) => {
        notifications++;
        heard.push(...ids);
      });
      const seen = new Map<string, AttachedState["kind"]>();
      const check = () => {
        expect(late, "an address made after the view closed").toEqual([]);
        for (const id of IDS) {
          const state = closed ? undefined : images.peek(id);
          const before = seen.get(id);
          if (state) {
            if (before && before !== "loading")
              expect(state.kind, `${id} left ${before}`).toBe(before);
            seen.set(id, state.kind);
          }
        }
        const shown = new Set(
          closed
            ? []
            : IDS.map((id) => images.peek(id)).flatMap((s) =>
                s?.kind === "shown" ? [s.url] : [],
              ),
        );
        for (const url of made)
          expect(shown.has(url) || revoked.has(url), `${url} leaks`).toBe(true);
        for (const id of IDS)
          expect(downloads.get(id) ?? 0).toBeLessThanOrEqual(1);
      };
      const settle = () =>
        new Promise<void>((resolve) => setTimeout(resolve, 0));

      // The view asks for some images, at steps the test draws.
      const asked = new Set<string>();
      for (let step = 0; step < 30; step++) {
        const act = tc.draw(
          gs.integers({ minValue: 0, maxValue: pending.length > 0 ? 4 : 1 }),
        );
        if (act === 0) {
          const id = tc.draw(gs.sampledFrom(IDS));
          asked.add(id);
          if (!closed) images.state(id);
        } else if (
          act === 1 &&
          !closed &&
          tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0
        ) {
          images.close();
          closed = true;
        } else if (pending.length > 0) {
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: pending.length - 1 }),
          );
          const [job] = pending.splice(at, 1);
          if (!job) continue;
          const [id = "", content] = job.id.split(":");
          if (job.what === "cached") {
            const k = kept.get(id);
            job.answer.resolve(k && new TextEncoder().encode(k));
          } else if (job.what === "download") {
            const s = served.get(id);
            if (s === "offline") job.answer.reject(new Error("offline"));
            else
              job.answer.resolve(
                s === "absent" ? "absent" : new TextEncoder().encode(s),
              );
          } else if (job.what === "open") {
            const opened: OpenedImage = {
              format: "png",
              bytes: new Uint8Array(0),
            };
            job.answer.resolve(content === "good" ? opened : "unreadable");
          } else if (tc.draw(gs.booleans())) {
            job.answer.resolve(undefined);
          } else {
            job.answer.reject(new Error("quota"));
          }
        }
        await settle();
        check();
      }
      // Everything ends, then the view closes.
      while (pending.length > 0) {
        const job = pending.shift() as Pending;
        const [id = "", content] = job.id.split(":");
        if (job.what === "cached")
          job.answer.resolve(
            kept.get(id) && new TextEncoder().encode(kept.get(id)),
          );
        else if (job.what === "download") {
          const s = served.get(id);
          if (s === "offline") job.answer.reject(new Error("offline"));
          else
            job.answer.resolve(
              s === "absent" ? "absent" : new TextEncoder().encode(s),
            );
        } else if (job.what === "open")
          job.answer.resolve(
            content === "good"
              ? { format: "png", bytes: new Uint8Array(0) }
              : "unreadable",
          );
        else job.answer.resolve(undefined);
        await settle();
        check();
      }
      if (!closed) {
        // What each image ended as, from what was kept and served.
        for (const id of asked) {
          const state = images.peek(id)?.kind;
          const expected =
            kept.get(id) === "good" || served.get(id) === "good"
              ? "shown"
              : served.get(id) === "absent"
                ? "absent"
                : served.get(id) === "offline"
                  ? "unavailable"
                  : "unreadable";
          expect(state, id).toBe(expected);
          expect(heard, `${id} told`).toContain(id);
          if (kept.get(id) === "good")
            expect(downloads.get(id) ?? 0, "kept: no download").toBe(0);
        }
        images.close();
        closed = true;
      }
      check();
      for (const url of made)
        expect(revoked.has(url), `${url} not revoked`).toBe(true);
      expect(notifications).toBeLessThanOrEqual(heard.length);
    }));

  test("an identifier that cites nothing is absent, without asking anything", () => {
    const never = () => {
      throw new Error("asked");
    };
    const images = createAttachedImages({
      cached: never,
      keep: never,
      download: never,
      open: never,
      url: never,
      revoke: never,
    });
    expect(images.state("")).toEqual({ kind: "absent" });
  });

  test("an image added while it downloads keeps one address", async () => {
    let release: (blob: Uint8Array) => void = () => {};
    const made: string[] = [];
    const images = createAttachedImages({
      cached: async () => undefined,
      keep: async () => {},
      download: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      open: async () => ({ format: "png", bytes: new Uint8Array(0) }),
      url: () => {
        made.push(`blob:${made.length}`);
        return made.at(-1) as string;
      },
      revoke: () => {},
    });
    expect(images.state("a").kind).toBe("loading");
    await new Promise((resolve) => setTimeout(resolve, 0));
    images.add("a", new Uint8Array(1), {
      format: "png",
      bytes: new Uint8Array(0),
    });
    release(new Uint8Array(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(made).toEqual(["blob:0"]);
    expect(images.state("a")).toEqual({
      kind: "shown",
      url: "blob:0",
      format: "png",
    });
  });
});
