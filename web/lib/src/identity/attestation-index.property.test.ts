// AT1, AT4 against a model (docs/protocol/06-identity.md, ID-37 – ID-40;
// analysis 18k): annotations signed by two keys, dated by their authors'
// clocks; attestations of those keys dated by the gateway's clock, by the
// configured gateway key or by another; revocation lists arriving in any
// order, older ones included; attestations erased, or replaced by other
// bytes, by someone who may write. The two clocks are drawn apart, both ways, often to a bound of a
// validity. At every step, once readings have ended: an object is attested
// exactly when a configured attestation of its key covers its date and the
// newest list read doesn't revoke the key by then, under the name of the
// attestation of greatest `issuedAt`.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { DecisionLog } from "../annotations/decisions.js";
import { draftAnnotation, writeAnnotation } from "../annotations/model.js";
import { sha256 } from "../annotations/sha256.js";
import {
  ATTESTATIONS,
  type RevocationList,
  addAttestation,
} from "./attestation.js";
import { encodeCanonical } from "./cbor.js";
import { sealAnnotation } from "./document-signing.js";
import { generateIdentityKey, signBytes } from "./keys.js";
import { SignatureIndex } from "./signature-index.js";
import { type Signer, signerOf } from "./signature.js";

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];
const DOC = "d";
const DAY = 24 * 3600;
const BASE = 1_800_000_000; // the gateway's clock, seconds
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let keysPromise: Promise<Signer[]> | undefined;
/** Two people's keys, the configured gateway's, another gateway's. */
const keys = () => {
  keysPromise ??= Promise.all(
    [0, 1, 2, 3].map(async () => signerOf(await generateIdentityKey())),
  );
  return keysPromise;
};

interface Made {
  id: string;
  envelope: Uint8Array;
  configured: boolean;
  key: string;
  name: string;
  issuedAt: number;
  expiresAt: number;
}

async function attestation(
  gateway: Signer,
  configured: boolean,
  key: Uint8Array,
  name: string,
  issuedAt: number,
): Promise<Made> {
  const msg = encodeCanonical({
    ctx: "oc-attestation/v1",
    issuer: "https://idp.test",
    sub: name,
    name,
    key,
    issuedAt,
    expiresAt: issuedAt + 30 * DAY,
  });
  const envelope = encodeCanonical({
    key: gateway.publicKey,
    msg,
    sig: await signBytes(gateway.privateKey, msg),
  });
  return {
    id: hex(sha256(envelope)),
    envelope,
    configured,
    key: hex(key),
    name,
    issuedAt,
    expiresAt: issuedAt + 30 * DAY,
  };
}

/** A date near a bound, or anywhere around the validities (seconds). */
function second(tc: TC, bounds: number[]): number {
  return tc.draw(gs.booleans())
    ? tc.draw(gs.sampledFrom(bounds)) +
        tc.draw(gs.integers({ minValue: -1, maxValue: 1 }))
    : BASE + tc.draw(gs.integers({ minValue: -2 * DAY, maxValue: 64 * DAY }));
}

describe("attested names against a model", () => {
  test("AT1, AT4: attested exactly when an attestation covers the date", () =>
    hegel.testAsync(
      async (tc: TC) => {
        const [k0, k1, gateway, other] = await keys();
        if (!k0 || !k1 || !gateway || !other) throw new Error("keys");
        const people = [k0, k1];
        const content = new LoroDoc();
        content.getText("content").insert(0, "Bonjour le monde");
        content.commit();
        const doc = new LoroDoc();
        const index = new SignatureIndex({
          documentId: DOC,
          annotationsDoc: doc,
          log: new DecisionLog(),
          attestationKeys: new Set([hex(sha256(gateway.publicKey))]),
        });

        // Attestations, by the gateway's clock; some by another gateway.
        const made: Made[] = [];
        const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        for (let n = 0; n < count; n++) {
          const person = tc.draw(gs.integers({ minValue: 0, maxValue: 1 }));
          const configured =
            tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0;
          made.push(
            await attestation(
              configured ? gateway : other,
              configured,
              (people[person] as Signer).publicKey,
              `Person ${person}.${n}`,
              BASE + tc.draw(gs.integers({ minValue: 0, maxValue: 40 })) * DAY,
            ),
          );
        }
        const bounds = made.flatMap((m) => [m.issuedAt, m.expiresAt]);
        bounds.push(BASE);

        // Objects, by their authors' clocks (milliseconds), each with
        // what attests it written in the same commit, or not.
        const objects: { id: string; key: string; date: number }[] = [];
        const present = new Set<string>();
        for (
          let n = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
          n > 0;
          n--
        ) {
          const key = tc.draw(gs.sampledFrom(people));
          // Often to the millisecond of a bound, or just before it.
          const date = tc.draw(gs.booleans())
            ? tc.draw(gs.sampledFrom(bounds)) * 1000 -
              tc.draw(gs.integers({ minValue: 0, maxValue: 1 }))
            : second(tc, bounds) * 1000 +
              tc.draw(gs.integers({ minValue: 0, maxValue: 999 }));
          const signing = { documentId: DOC, signer: async () => key };
          const draft = draftAnnotation(content, {
            type: "comment",
            start: 0,
            end: 3,
            author: "same name",
            body: `body ${n}`,
            createdAt: date,
          });
          for (const m of made) {
            if (m.key === hex(key.publicKey) && tc.draw(gs.booleans())) {
              addAttestation(doc, m.envelope);
              present.add(m.id);
            }
          }
          writeAnnotation(doc, draft, await sealAnnotation(signing, draft));
          objects.push({ id: draft.id, key: hex(key.publicKey), date });
        }

        let retained: RevocationList | undefined;
        for (
          let step = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
          step > 0;
          step--
        ) {
          switch (tc.draw(gs.integers({ minValue: 0, maxValue: 4 }))) {
            case 0: {
              // A list, newer or older than the one retained (AT4).
              const revoked = new Map<string, number>();
              for (const person of people) {
                if (tc.draw(gs.booleans())) {
                  revoked.set(
                    hex(sha256(person.publicKey)),
                    second(tc, bounds),
                  );
                }
              }
              const list = {
                issuedAt: tc.draw(gs.integers({ minValue: 0, maxValue: 5 })),
                revoked,
              };
              index.setRevocations(list);
              if (!retained || list.issuedAt > retained.issuedAt)
                retained = list;
              break;
            }
            case 1: {
              // Erased by someone who may write.
              const id = [...present][0];
              if (id) {
                doc.getMap(ATTESTATIONS).delete(id);
                doc.commit();
                present.delete(id);
              }
              break;
            }
            case 2: {
              const m = made.find((x) => !present.has(x.id));
              if (m) {
                addAttestation(doc, m.envelope);
                doc.commit();
                present.add(m.id);
              }
              break;
            }
            case 3: {
              // Other bytes under an entry's key: as good as erased.
              const id = [...present][0];
              if (id) {
                doc.getMap(ATTESTATIONS).set(id, new Uint8Array([1, 2, 3]));
                doc.commit();
                present.delete(id);
              }
              break;
            }
            default:
              // Nothing: an index read again at rest says the same.
              break;
          }
          await index.idle();
          const view = index.current();
          for (const object of objects) {
            const revokedAt = retained?.revoked.get(
              hex(sha256(Buffer.from(object.key, "hex"))),
            );
            const covering = made
              .filter(
                (m) =>
                  present.has(m.id) &&
                  m.configured &&
                  m.key === object.key &&
                  m.issuedAt * 1000 <= object.date &&
                  object.date < m.expiresAt * 1000 &&
                  (revokedAt === undefined || object.date < revokedAt * 1000),
              )
              .sort(
                (a, b) => b.issuedAt - a.issuedAt || (a.id < b.id ? -1 : 1),
              );
            const verdict = view.of("annotation", object.id);
            expect(verdict.signed, "signed by its key").toBe(true);
            const attested = verdict.signed ? verdict.attested : undefined;
            expect(attested?.name, JSON.stringify(object)).toBe(
              covering[0]?.name,
            );
            expect(verdict.signed && verdict.revokedAt).toBe(
              revokedAt ?? undefined,
            );
          }
        }
        index.destroy();
      },
      { testCases: 100 },
    ));
});
