// Opens a document from its link, prints its text and annotations, and,
// if given some text, appends it, waits until the server holds it, and
// leaves. Run `npm run build:lib` first, then:
//
//   node lib/examples/read-and-write.mjs '<link>' ['text to append'] ['http://localhost:8080']
//
// The third argument is the server, when it isn't the link's origin.
import { listAnnotations, openLink } from "../dist/index.js";

const [link, append, server] = process.argv.slice(2);
if (!link) {
  console.error("usage: read-and-write.mjs <link> [text] [server]");
  process.exit(2);
}

const doc = await openLink(link, server ? { server } : {});
const text = doc.content.getText("content");
console.log(`document ${doc.documentId}, as ${doc.role}`);
console.log(text.toString());
for (const annotation of listAnnotations(doc.content, doc.annotations)) {
  const status =
    doc.decisions.winner(annotation.id)?.decision ?? annotation.status;
  console.log(`[${annotation.type}] ${annotation.author} (${status})`);
}

if (append) {
  text.insert(text.length, append);
  doc.content.commit();
  await doc.whenPublished();
  console.log(`appended ${JSON.stringify(append)}`);
}
doc.close();
