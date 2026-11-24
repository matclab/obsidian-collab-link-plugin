// D-44: who a reply or a rejection notifies.
import { LoroDoc, type LoroList, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  draftAnnotation,
  draftReply,
  writeAnnotation,
  writeReply,
} from "../annotations/model.js";
import { generateIdentityKey } from "../identity/keys.js";
import {
  annotationMessage,
  replyMessage,
  subscriptionMessage,
} from "../identity/messages.js";
import { type Signer, sign, signerOf } from "../identity/signature.js";
import { recipientsOf } from "./recipients.js";
import {
  type SubscriptionFields,
  subscriptionKey,
  writeSubscription,
} from "./subscriptions.js";

const DOC = "0123456789abcdef0123456789abcdef";
const VAPID = new Uint8Array(32).fill(7);
const OTHER_VAPID = new Uint8Array(32).fill(8);

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

async function person(): Promise<Signer> {
  return signerOf(await generateIdentityKey());
}

function setup() {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "Bonjour le monde");
  contentDoc.commit();
  return { contentDoc, annotationsDoc: new LoroDoc() };
}

async function annotate(
  docs: ReturnType<typeof setup>,
  by: Signer | undefined,
  type: "comment" | "deletion" = "comment",
): Promise<string> {
  const draft = draftAnnotation(docs.contentDoc, {
    type,
    start: 0,
    end: 7,
    author: "A",
    ...(type === "comment" && { body: "?" }),
  });
  const seal = by && {
    sig: await sign(by, (s) =>
      annotationMessage({ documentId: DOC, signer: s }, draft.id, draft.fields),
    ),
    signer: by,
  };
  writeAnnotation(docs.annotationsDoc, draft, seal);
  return draft.id;
}

async function reply(
  docs: ReturnType<typeof setup>,
  annotationId: string,
  by: Signer | undefined,
): Promise<string> {
  const draft = draftReply(docs.annotationsDoc, annotationId, {
    author: "R",
    body: "oui",
  });
  const seal = by && {
    sig: await sign(by, (s) =>
      replyMessage({ documentId: DOC, signer: s }, draft.id, {
        annotation: annotationId,
        ...draft.fields,
      }),
    ),
    signer: by,
  };
  writeReply(docs.annotationsDoc, draft, seal);
  return draft.id;
}

let device = 0;
async function subscribe(
  docs: ReturnType<typeof setup>,
  by: Signer,
  vapid = VAPID,
): Promise<string> {
  device++;
  const fields: SubscriptionFields = {
    endpoint: `https://fcm.googleapis.com/wp/${device}`,
    p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(device)),
    auth: new Uint8Array(16).fill(device),
    vapid,
    createdAt: 1000,
  };
  const key = subscriptionKey(fields.endpoint);
  const sig = await sign(by, (s) =>
    subscriptionMessage({ documentId: DOC, signer: s }, key, fields),
  );
  writeSubscription(docs.annotationsDoc, fields, { sig, signer: by });
  return fields.endpoint;
}

const endpoints = (list: { fields: { endpoint: string } }[]) =>
  list.map((s) => s.fields.endpoint).sort();

describe("recipients (D-44)", () => {
  test("a reply notifies the thread's signers before it, at each of their subscriptions, never me", async () => {
    const docs = setup();
    const [alice, bob, carol, me] = await Promise.all([
      person(),
      person(),
      person(),
      person(),
    ]);
    const a = await annotate(docs, alice);
    await reply(docs, a, bob);
    const mine = await reply(docs, a, me);
    await reply(docs, a, carol); // after mine: not concerned
    const alicePhone = await subscribe(docs, alice);
    const aliceLaptop = await subscribe(docs, alice);
    const bobPhone = await subscribe(docs, bob);
    await subscribe(docs, carol);
    await subscribe(docs, me);
    const found = await recipientsOf({
      annotationsDoc: docs.annotationsDoc,
      documentId: DOC,
      annotationId: a,
      of: { reply: mine },
      mine: new Set([toHex(me.fingerprint)]),
      vapid: VAPID,
    });
    expect(endpoints(found)).toEqual(
      [alicePhone, aliceLaptop, bobPhone].sort(),
    );
  });

  test("a rejection notifies the suggestion's signer alone, unless it is mine", async () => {
    const docs = setup();
    const [alice, bob, me] = await Promise.all([person(), person(), person()]);
    const a = await annotate(docs, alice, "deletion");
    await reply(docs, a, bob);
    const alicePhone = await subscribe(docs, alice);
    await subscribe(docs, bob);
    const query = {
      annotationsDoc: docs.annotationsDoc,
      documentId: DOC,
      annotationId: a,
      of: "rejection" as const,
      vapid: VAPID,
    };
    expect(
      endpoints(
        await recipientsOf({
          ...query,
          mine: new Set([toHex(me.fingerprint)]),
        }),
      ),
    ).toEqual([alicePhone]);
    expect(
      await recipientsOf({
        ...query,
        mine: new Set([toHex(alice.fingerprint)]),
      }),
    ).toEqual([]);
  });

  test("an unsigned entry notifies no one, and a subscription of another VAPID key is skipped", async () => {
    const docs = setup();
    const [alice, me] = await Promise.all([person(), person()]);
    const a = await annotate(docs, undefined);
    const first = await reply(docs, a, alice);
    const mine = await reply(docs, a, me);
    await subscribe(docs, alice, OTHER_VAPID);
    const query = {
      annotationsDoc: docs.annotationsDoc,
      documentId: DOC,
      annotationId: a,
      mine: new Set([toHex(me.fingerprint)]),
      vapid: VAPID,
    };
    expect(await recipientsOf({ ...query, of: { reply: mine } })).toEqual([]);
    const phone = await subscribe(docs, alice);
    expect(
      endpoints(await recipientsOf({ ...query, of: { reply: mine } })),
    ).toEqual([phone]);
    // Before Alice's reply, nobody signed: nobody to notify.
    expect(await recipientsOf({ ...query, of: { reply: first } })).toEqual([]);
  });

  test("replies sharing an id don't count (ID-10), nor a reply not found", async () => {
    const docs = setup();
    const [alice, me] = await Promise.all([person(), person()]);
    const a = await annotate(docs, undefined);
    const copied = await reply(docs, a, alice);
    // A copy of Alice's reply, its id and sig, under another text.
    const list = docs.annotationsDoc.getMap("annotations").get(a) as LoroMap;
    const replies = list.get("replies") as LoroList;
    const original = replies.get(0) as LoroMap;
    const copy = replies.insertContainer(1, new LoroMap());
    for (const field of ["author", "createdAt", "id", "sig"]) {
      copy.set(field, original.get(field) as never);
    }
    copy.set("body", "autre chose");
    docs.annotationsDoc.commit();
    const mine = await reply(docs, a, me);
    await subscribe(docs, alice);
    const query = {
      annotationsDoc: docs.annotationsDoc,
      documentId: DOC,
      annotationId: a,
      mine: new Set([toHex(me.fingerprint)]),
      vapid: VAPID,
    };
    expect(await recipientsOf({ ...query, of: { reply: mine } })).toEqual([]);
    expect(await recipientsOf({ ...query, of: { reply: "nope" } })).toEqual([]);
    expect(copied).toBeTruthy();
  });
});
