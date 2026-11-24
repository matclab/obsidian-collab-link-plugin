// @vitest-environment node
//
// Phase 18g (docs/protocol/06-identity.md, §6.4, informative note; ADR-0027):
// a client of version 1 that doesn't sign reads a signed document as it
// read it before. The independent client — whose reader of annotations,
// replies, history tables and decisions knows nothing of signatures —
// lists the same annotations, replies, names and versions from a document
// where everything is signed (`sig`, `identities`, `peerSignatures`, a
// reply's `id`, a record's `sig`) as from the same document unsigned.
import { LoroDoc } from "loro-crdt";
import { beforeAll, describe, expect, test } from "vitest";
import {
  type DocumentSigning,
  draftAnnotation,
  draftReply,
  draftVersion,
  encodeProposal,
  generateIdentityKey,
  registerPeers,
  sealAnnotation,
  sealPeers,
  sealReply,
  sealVersion,
  signerOf,
  writeAnnotation,
  writeReply,
  writeVersion,
} from "../../lib/src/index.js";
import { linkIndependentLoro } from "./independent-loro.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;
// biome-ignore lint/suspicious/noExplicitAny: the independent client's Loro.
let IndependentLoroDoc: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/protocol.mjs");
  ({ LoroDoc: IndependentLoroDoc } = await import(
    "../../../independent-client/node_modules/loro-crdt/nodejs/index.js"
  ));
});

/** The same document, written signed or not: two comments, a reply, a
 * version, a name. */
async function document(signing: DocumentSigning | undefined) {
  const content = new LoroDoc();
  content.setPeerId(1n);
  content.getText("content").insert(0, "Bonjour le monde entier");
  content.commit();
  const annotations = new LoroDoc();
  annotations.setPeerId(2n);
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  for (const [n, id] of ids.entries()) {
    const draft = draftAnnotation(
      content,
      {
        type: "comment",
        start: n * 8,
        end: n * 8 + 6,
        author: "Alice",
        body: `c${n}`,
        createdAt: 1000 + n,
      },
      id,
    );
    writeAnnotation(annotations, draft, await sealAnnotation(signing, draft));
  }
  const reply = draftReply(annotations, ids[0] as string, {
    author: "Bob",
    body: "oui",
    createdAt: 2000,
  });
  writeReply(annotations, reply, await sealReply(signing, reply));
  const version = draftVersion([{ peer: "1", counter: 3 }], {
    name: "V1",
    author: "Alice",
    at: 3000,
  });
  writeVersion(annotations, version, await sealVersion(signing, version));
  registerPeers(
    annotations,
    ["2"],
    "Alice",
    await sealPeers(signing, ["2"], "Alice"),
  );
  return { content, annotations };
}

function read(docs: { content: LoroDoc; annotations: LoroDoc }) {
  const c = new IndependentLoroDoc();
  c.import(docs.content.export({ mode: "snapshot" }));
  const a = new IndependentLoroDoc();
  a.import(docs.annotations.export({ mode: "snapshot" }));
  const listed = independent.listAnnotations(a, c) as Record<string, unknown>[];
  return {
    annotations: listed.map(({ replies, ...rest }) => ({
      ...rest,
      // A reply's own fields (D-38): the signed one carries an `id`, which
      // a version-1 reader doesn't list.
      replies: (
        replies as { author: string; createdAt: number; body: string }[]
      ).map(({ author, createdAt, body }) => ({ author, createdAt, body })),
    })),
    peers: independent.listPeers(a),
    versions: (independent.listVersions(a) as { id: string }[]).map(
      ({ id, ...rest }) => rest,
    ),
  };
}

describe("a signed document, read by a client of version 1", () => {
  test("lists the same as unsigned", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const signed = await document({
      documentId: "d",
      signer: async () => signer,
    });
    expect(signed.annotations.getMap("identities").size).toBe(1);
    const plain = await document(undefined);
    const fromSigned = read(signed);
    expect(fromSigned.annotations).toHaveLength(2);
    expect(fromSigned).toEqual(read(plain));
  });

  test("a signed decision record is the same decision", () => {
    const record = {
      proposalId: "p",
      annotationId: "a",
      decision: "reject" as const,
      author: "Alice",
    };
    const plain = independent.parseDecision(encodeProposal(record));
    const signed = independent.parseDecision(
      encodeProposal({ ...record, sig: new Uint8Array(72).fill(3) }),
    );
    expect(plain).toBeTruthy();
    expect(signed).toEqual(plain);
  });
});
