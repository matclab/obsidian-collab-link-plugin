// SG1, SG6 against a model (phase 18, decision 10; docs/protocol/
// 06-identity.md, ID-15, ID-16): annotations and replies signed by a few
// keys, then a reviewer's rewrites drawn at random — a signed field
// changed, changed back, an unsigned one changed, a key removed from
// `identities` or put back, a signature copied onto another object. At
// every step, once the verifications have ended: an object reads signed,
// by its key, exactly when its signed fields are those it was signed with
// and its key is known; otherwise unverified.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, type LoroList, type LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { DecisionLog } from "../annotations/decisions.js";
import {
  draftAnnotation,
  draftReply,
  writeAnnotation,
  writeReply,
} from "../annotations/model.js";
import { sealAnnotation, sealReply } from "./document-signing.js";
import { generateIdentityKey } from "./keys.js";
import { SignatureIndex, replyKey } from "./signature-index.js";
import { type Signer, signerOf } from "./signature.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];
const DOC = "d";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** What an object was signed with, as the model holds it. */
interface Signed {
  kind: "annotation" | "reply";
  id: string; // as `of` takes it
  key: Signer;
  fields: Record<string, unknown>;
  /** Reads the object's current signed fields and sig from the doc. */
  current(): { fields: Record<string, unknown>; sig: unknown } | undefined;
  /** The map holding it, to rewrite. */
  map(): LoroMap;
  /** Whose signature it carries now: its own, or one copied. */
  carries?: Signed;
}

let keysPromise: Promise<Signer[]> | undefined;
const keys = () => {
  keysPromise ??= Promise.all(
    [0, 1].map(async () => signerOf(await generateIdentityKey())),
  );
  return keysPromise;
};

describe("the signature index against a model", () => {
  test(
    "SG1, SG6: signed exactly when the fields are as signed and the key is known",
    () =>
      hegel.testAsync(
        async (tc: TC) => {
          const [k0, k1] = await keys();
          if (!k0 || !k1) throw new Error("keys");
          const content = new LoroDoc();
          content.getText("content").insert(0, "Bonjour le monde");
          content.commit();
          const doc = new LoroDoc();
          const index = new SignatureIndex({
            documentId: DOC,
            annotationsDoc: doc,
            log: new DecisionLog(),
          });
          const objects: Signed[] = [];
          const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
          for (let n = 0; n < count; n++) {
            const key = tc.draw(gs.booleans()) ? k0 : k1;
            const signing = { documentId: DOC, signer: async () => key };
            const draft = draftAnnotation(content, {
              type: "comment",
              start: 0,
              end: 3,
              author: `author${n % 2}`,
              body: `body ${n}`,
              createdAt: 1000 + n,
            });
            writeAnnotation(doc, draft, await sealAnnotation(signing, draft));
            const entry = () =>
              doc.getMap("annotations").get(draft.id) as LoroMap;
            objects.push({
              kind: "annotation",
              id: draft.id,
              key,
              fields: { ...draft.fields },
              map: entry,
              current: () => {
                const e = entry();
                return {
                  fields: {
                    type: e.get("type"),
                    author: e.get("author"),
                    createdAt: e.get("createdAt"),
                    body: e.get("body"),
                  },
                  sig: e.get("sig"),
                };
              },
            });
            if (tc.draw(gs.booleans())) {
              const reply = draftReply(doc, draft.id, {
                author: "replier",
                body: "ok",
                createdAt: 2000 + n,
              });
              writeReply(doc, reply, await sealReply(signing, reply));
              const element = () =>
                (entry().get("replies") as LoroList).get(0) as LoroMap;
              objects.push({
                kind: "reply",
                id: replyKey(draft.id, reply.id),
                key,
                fields: { ...reply.fields },
                map: element,
                current: () => {
                  const e = element();
                  return {
                    fields: {
                      author: e.get("author"),
                      createdAt: e.get("createdAt"),
                      body: e.get("body"),
                    },
                    sig: e.get("sig"),
                  };
                },
              });
            }
          }
          const identities = doc.getMap("identities");
          const removed = new Set<string>();

          for (
            let step = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
            step > 0;
            step--
          ) {
            const object = tc.draw(gs.sampledFrom(objects));
            const move = tc.draw(
              gs.sampledFrom([
                "field",
                "back",
                "status",
                "key",
                "copy",
              ] as const),
            );
            if (move === "field") {
              const name = tc.draw(
                gs.sampledFrom(
                  object.kind === "annotation"
                    ? ["author", "body", "createdAt", "type"]
                    : ["author", "body", "createdAt"],
                ),
              );
              const value =
                name === "createdAt"
                  ? tc.draw(gs.sampledFrom([0, 1.5, 999]))
                  : name === "type"
                    ? "deletion"
                    : tc.draw(gs.sampledFrom(["x", "author0", ""]));
              object.map().set(name, value as never);
            } else if (move === "back") {
              for (const [name, value] of Object.entries(object.fields)) {
                object.map().set(name, value as never);
              }
            } else if (move === "status" && object.kind === "annotation") {
              // Not signed: changes nothing.
              object.map().set("status", "resolved");
            } else if (move === "key") {
              const name = hex(object.key.fingerprint);
              if (removed.has(name)) {
                identities.set(name, object.key.publicKey);
                removed.delete(name);
              } else {
                identities.delete(name);
                removed.add(name);
              }
            } else if (move === "copy") {
              const other = tc.draw(gs.sampledFrom(objects));
              const sig = other.current()?.sig;
              if (sig instanceof Uint8Array) {
                object.map().set("sig", sig);
                object.carries = other.carries ?? other;
              }
            }
            doc.commit();
            await index.idle();
            const view = index.current();
            for (const o of objects) {
              const now = o.current();
              const expected =
                now !== undefined &&
                (o.carries ?? o) === o &&
                Object.entries(o.fields).every(
                  ([n, v]) => now.fields[n] === v,
                ) &&
                !removed.has(hex(o.key.fingerprint));
              const verdict = view.of(o.kind, o.id);
              expect(verdict.signed, `${o.kind} ${o.id} after ${move}`).toBe(
                expected,
              );
              if (verdict.signed) {
                expect(hex(verdict.fingerprint)).toBe(hex(o.key.fingerprint));
              }
            }
          }
          index.destroy();
        },
        { testCases: 150 },
      ),
    300_000,
  );
});
