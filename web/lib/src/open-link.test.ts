// Opening a document from its link, without a page (docs/phase-8-
// protocole-ouvert.md, C4): what a plugin or a script calls.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { encodeProposal } from "./annotations/decisions.js";
import { createAnnotation } from "./annotations/model.js";
import { encrypt, exportKeyToBase64Url, generateKey } from "./crypto/aead.js";
import { formatLinkFragment } from "./crypto/link-fragment.js";
import { openLink } from "./open-link.js";
import { eventually } from "./transport/test-support/eventually.js";
import { FakeServer } from "./transport/test-support/fake-server.js";

const DOC = "0123456789abcdef0123456789abcdef";
const secret = new Uint8Array(32).fill(5);

async function seeded() {
  const key = await generateKey();
  const server = new FakeServer();
  const content = new LoroDoc();
  content.getText("content").insert(0, "hello world");
  content.commit();
  const annotations = new LoroDoc();
  const id = createAnnotation(content, annotations, {
    type: "comment",
    start: 0,
    end: 5,
    author: "alice",
    body: "hi",
  });
  server.append(
    DOC,
    "content",
    await encrypt(key, content.export({ mode: "update" })),
  );
  server.append(
    DOC,
    "annotations",
    await encrypt(key, annotations.export({ mode: "update" })),
  );
  server.append(
    DOC,
    "decisions",
    await encrypt(
      key,
      encodeProposal({
        proposalId: "p",
        annotationId: id,
        decision: "resolve",
        author: "bob",
      }),
    ),
  );
  const link = `https://notes.example/?doc=${DOC}${formatLinkFragment({
    key: await exportKeyToBase64Url(key),
    role: "edit",
    secret,
  })}`;
  const urls: string[] = [];
  const socketFactory = (url: string) => {
    urls.push(url);
    return server.connect();
  };
  return { server, link, id, urls, socketFactory };
}

describe("openLink", () => {
  test("reads the text, the annotations and the confirmed decisions", async () => {
    const { link, id, socketFactory } = await seeded();

    const opened = await openLink(link, { socketFactory });

    expect(opened.documentId).toBe(DOC);
    expect(opened.role).toBe("edit");
    expect(opened.content.getText("content").toString()).toBe("hello world");
    expect(opened.annotations.getMap("annotations").get(id)).toBeDefined();
    expect(opened.decisions.resolution(id)?.proposalId).toBe("p");
    opened.close();
  });

  test("what one writes reaches the other", async () => {
    const { link, socketFactory } = await seeded();
    const writer = await openLink(link, { socketFactory });
    const reader = await openLink(link, { socketFactory });

    writer.content.getText("content").insert(0, "say ");
    writer.content.commit();

    await eventually(
      () => reader.content.getText("content").toString() === "say hello world",
    );
    writer.close();
    reader.close();
  });

  test("whenPublished resolves once the server holds what this client wrote", async () => {
    const { server, link, socketFactory } = await seeded();
    const writer = await openLink(link, { socketFactory });
    await writer.whenPublished(); // nothing written yet
    const before = server.journaled(DOC);

    writer.content.getText("content").insert(0, "a");
    writer.content.commit();
    const journaledThen = await writer
      .whenPublished()
      .then(() => server.journaled(DOC));

    expect(journaledThen).toBe(before + 1);
    writer.close();
  });

  test("connects to the link's origin unless told otherwise (K-3)", async () => {
    const { link, urls, socketFactory } = await seeded();

    (await openLink(link, { socketFactory })).close();
    (
      await openLink(link, { socketFactory, server: "http://localhost:8080" })
    ).close();

    (
      await openLink(link, {
        socketFactory,
        server: "https://notes.example/collab/",
      })
    ).close();

    expect(urls).toEqual([
      "wss://notes.example/ws",
      "ws://localhost:8080/ws",
      "wss://notes.example/collab/ws",
    ]);
  });

  test.each([
    ["no document id", (link: string) => link.replace(`?doc=${DOC}`, "")],
    ["no fragment", (link: string) => link.slice(0, link.indexOf("#"))],
    [
      "a fragment without its secret",
      (link: string) => link.replace(/&r=.*/, ""),
    ],
    ["not a URL", () => "not a link"],
  ])("refuses a link with %s, connecting to nothing", async (_, broken) => {
    const { link, urls, socketFactory } = await seeded();

    await expect(openLink(broken(link), { socketFactory })).rejects.toThrow();
    expect(urls).toEqual([]);
  });

  test("refuses to send a secret in clear to another host", async () => {
    const { link, urls, socketFactory } = await seeded();

    await expect(
      openLink(link, { socketFactory, server: "http://notes.example" }),
    ).rejects.toThrow(/TLS/);
    expect(urls).toEqual([]);
  });
});
