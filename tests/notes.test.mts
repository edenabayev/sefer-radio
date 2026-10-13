// פתקים וסיכום שיחה במצב דמה (אחסון מקומי).
process.env.MOCK_AI = "1";
delete process.env.BLOB_READ_WRITE_TOKEN;
import assert from "node:assert/strict";
import { addNote, listNotes, deleteNote, summarizeConversation } from "../src/lib/conversation";
import type { Book } from "../src/lib/books";

const book: Book = {
  id: "test-notes",
  title: "ספר בדיקה",
  lang: "he",
  source: { type: "upload", url: "x", filename: "x.txt", kind: "txt" },
  createdAt: new Date().toISOString(),
  chapters: [{ title: "פרק א", start: 0, end: 1 }],
  sections: [{ i: 0, chapter: 0, text: "אחת" }, { i: 1, chapter: 0, text: "שתיים" }],
};

const before = await listNotes(book.id);
for (const n of before) await deleteNote(book.id, n.id);

const n1 = await addNote(book, { section: 1, kind: "saved", title: "רעיון", text: "החופש הוא אחריות" });
assert.equal(n1.chapter, "פרק א");
let all = await listNotes(book.id);
assert.equal(all.length, 1);
assert.equal(all[0].id, n1.id);

// שיחה קצרה מדי — אין סיכום
assert.equal(await summarizeConversation(book, 1, [{ role: "user", text: "היי" }, { role: "model", text: "שלום" }]), null);
// שיחה אמיתית — נוצר פתק סיכום
const sum = await summarizeConversation(book, 1, [
  { role: "user", text: "מה סארטר מתכוון כשהוא אומר שאנחנו נידונים לחופש?" },
  { role: "model", text: "שאין לנו ברירה אלא לבחור, וגם אי-בחירה היא בחירה." },
  { role: "user", text: "אז האחריות היא על הכל, גם על מה שלא בחרתי?" },
  { role: "model", text: "על האופן שבו אתה נושא את מה שלא בחרת." },
]);
assert.ok(sum && sum.kind === "summary" && sum.text.length > 0);
all = await listNotes(book.id);
assert.equal(all.length, 2);
assert.equal(all[0].kind, "summary");

await deleteNote(book.id, n1.id);
all = await listNotes(book.id);
assert.equal(all.length, 1);
for (const n of all) await deleteNote(book.id, n.id);
console.log("notes ok");
