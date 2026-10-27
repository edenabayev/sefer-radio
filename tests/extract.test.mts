// קריאת PDF בצעדים: כל צעד בקובץ משלו; book.json שנקרא בגרסה ישנה לא גורם לכפילות; "קרא מחדש" מתחיל מאפס.
process.env.MOCK_AI = "1";
process.env.LOCAL_PDF_CHUNK = "4"; // ספר של 9 עמודים → 3 צעדים
delete process.env.BLOB_READ_WRITE_TOKEN;
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import * as store from "../src/lib/storage";
import { extractStep, getBook, saveBook, type Book } from "../src/lib/books";

const id = "test-extract";
for (const p of await store.listPaths(`books/${id}/`)) await store.remove(p);
await store.writeBytes(`uploads/${id}.pdf`, readFileSync("tests/fixtures/textlayer.pdf"), "application/pdf");
const book: Book = {
  id,
  title: "Text Layer",
  lang: "other",
  source: { type: "upload", url: "http://local.invalid/x.pdf", pathname: `uploads/${id}.pdf`, filename: "x.pdf", kind: "pdf" },
  createdAt: new Date().toISOString(),
  chapters: [],
  sections: [],
  extraction: { status: "pending", totalPages: 9, nextPage: 1, markdown: "" },
};
await saveBook(book);

const paraCount = (b: Book) => b.sections.map((s) => s.text).join("\n\n").split(/\n\n+/).filter((p) => p.startsWith("Paragraph")).length;

// צעד 1 (עמודים 1–4)
let r = await extractStep(id);
assert.equal(r.book.extraction?.nextPage, 5);
assert.equal(r.book.lang, "en");
const stale = JSON.parse(JSON.stringify(r.book)) as Book;
// book.json "ישן" (כמו קריאה מה-Blob מיד אחרי כתיבה): עדיין עמוד 1
stale.extraction!.nextPage = 1;
stale.sections = [];
await saveBook(stale);
r = await extractStep(id);
assert.equal(r.book.extraction?.nextPage, 9, "ממשיכים מקבצי הצעדים (5–8), לא מהעמוד הישן");
r = await extractStep(id);
assert.equal(r.book.extraction?.status, "done");
assert.deepEqual(r.book.chapters.map((c) => c.title), ["Chapter 1", "Chapter 2", "Chapter 3"]);
assert.equal(paraCount(r.book), 27, "כל פסקה פעם אחת — בלי כפילות");
assert.deepEqual((await store.listPaths(`books/${id}/extract/`)).map((p) => p.split("/").pop()).sort(), ["00001-00004.md", "00005-00008.md", "00009-00009.md"]);

// צעד נוסף אחרי שהכל נקרא — לא עושה כלום
r = await extractStep(id);
assert.equal(paraCount(r.book), 27);

// קריאה מחדש מאפס
r = await extractStep(id, { restart: true });
assert.equal(r.book.extraction?.nextPage, 5);
while ((await getBook(id))!.extraction!.status === "pending") await extractStep(id);
assert.equal(paraCount((await getBook(id))!), 27);

for (const p of await store.listPaths(`books/${id}/`)) await store.remove(p);
await store.remove(`uploads/${id}.pdf`);
console.log("extract ok");
