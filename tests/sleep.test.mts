// שעון שינה: מצב "לילה", רשימת הפסקאות עם שעות, ו"מה פספסתי" (אחסון מקומי, מצב דמה).
process.env.MOCK_AI = "1";
delete process.env.BLOB_READ_WRITE_TOKEN;
import assert from "node:assert/strict";
import * as store from "../src/lib/storage";
import { startSession, markSession, latestSession, sessionState, nightParagraphs, missed } from "../src/lib/sleep";
import { audioDirFor } from "../src/lib/prepare";
import type { Book, Progress } from "../src/lib/books";

const book: Book = {
  id: "test-sleep",
  title: "ספר לילה",
  lang: "he",
  source: { type: "upload", url: "x", filename: "x.txt", kind: "txt" },
  createdAt: new Date().toISOString(),
  chapters: [{ title: "א", start: 0, end: 3 }],
  sections: [0, 1, 2, 3].map((i) => ({ i, chapter: 0, text: `פסקה ראשונה של קטע ${i}. `.repeat(5) + "\n\n" + `פסקה שנייה של קטע ${i}. `.repeat(5) })),
};
// ניקוי משאריות
for (const p of await store.listPaths(`books/${book.id}/`)) await store.remove(p);
// כל קטע = 60 שניות שמע (48kbps → 6000 בייט לשנייה)
const dir = audioDirFor(book, "Puck", "he");
for (const i of [0, 1, 2, 3]) await store.writeBytes(`${dir}${i}.mp3`, Buffer.alloc(60 * 6000), "audio/mpeg");

const prog = (section: number, offset: number): Progress => ({ section, offset, lang: "he", study: true, voice: "Puck", updatedAt: new Date().toISOString() });
const T0 = Date.parse("2026-10-26T21:00:00Z");

// אין לילה
assert.equal(sessionState(await latestSession(book.id), prog(0, 0), T0).pending, false);

// הפעלת טיימר של 10 דקות בקטע 1, שנייה 30
const s = await startSession(book.id, { section: 1, offset: 30, lang: "he", voice: "Puck", rate: 1, minutes: 10 }, T0);
let st = sessionState(await latestSession(book.id), prog(1, 40), T0 + 5 * 60_000);
assert.equal(st.pending, false, "הטיימר עוד רץ — אין לילה פתוח");
// הטיימר נגמר (בלי סימון עצירה) — הסוף לפי ההתקדמות השמורה
st = sessionState(await latestSession(book.id), prog(3, 15), T0 + 11 * 60_000);
assert.equal(st.pending, true);
assert.deepEqual(st.end, { section: 3, offset: 15 });
// סימון עצירה מהדפדפן גובר על ההתקדמות
await markSession(book.id, s.id, "fired", { section: 2, offset: 50 }, T0 + 10 * 60_000);
const sess = await latestSession(book.id);
st = sessionState(sess, prog(3, 15), T0 + 11 * 60_000);
assert.deepEqual(st.end, { section: 2, offset: 50 });

// הפסקאות שהתנגנו: קטע 1 משנייה 30 (הפסקה השנייה מתחילה ב~30ש), קטע 2 עד שנייה 50
const night = await nightParagraphs(book, sess!, st.end!);
assert.deepEqual(night.map((n) => [n.section, n.para]), [[1, 0], [1, 1], [2, 0], [2, 1]]);
// שעה: הפסקה הראשונה של קטע 2 מתחילה 30 שניות אחרי ההפעלה (קטע 1 נשמע מ-30 עד 60)
assert.equal(Date.parse(night[2].clock) - T0, 30_000);
assert.ok(night[1].ratio > 0.4 && night[1].ratio < 0.6, String(night[1].ratio));

// "מה פספסתי" בזמן לילה פתוח → סיכום הלילה
const m1 = await missed(book, prog(3, 15), T0 + 11 * 60_000);
assert.equal(m1.kind, "sleep");
assert.ok(m1.text.length > 0 && m1.url);
// סגירה → אין לילה פתוח, ו"מה פספסתי" חוזר לסיכום של מה ששמעת לאחרונה
await markSession(book.id, s.id, "done", undefined, T0 + 12 * 60_000);
assert.equal(sessionState(await latestSession(book.id), prog(3, 15), T0 + 12 * 60_000).pending, false);
const m2 = await missed(book, prog(3, 15), T0 + 12 * 60_000);
assert.equal(m2.kind, "recent");

// ביטול → לא פתוח גם אחרי שהזמן עבר
const s2 = await startSession(book.id, { section: 0, offset: 0, lang: "he", voice: "Puck", rate: 1, minutes: 5 }, T0 + 20 * 60_000);
await markSession(book.id, s2.id, "cancel", undefined, T0 + 21 * 60_000);
assert.equal(sessionState(await latestSession(book.id), prog(2, 0), T0 + 40 * 60_000).pending, false);
// טיימר שנגמר בלי שום התקדמות — אין לילה
await startSession(book.id, { section: 2, offset: 10, lang: "he", voice: "Puck", rate: 1.5, minutes: 5 }, T0 + 50 * 60_000);
assert.equal(sessionState(await latestSession(book.id), prog(2, 12), T0 + 60 * 60_000).pending, false);
// מהירות 1.5: השעון רץ מהר יותר מהשמע
const s3 = await startSession(book.id, { section: 0, offset: 0, lang: "he", voice: "Puck", rate: 1.5, minutes: 5 }, T0 + 70 * 60_000);
const n3 = await nightParagraphs(book, s3, { section: 1, offset: 0 });
assert.ok(Math.abs(Date.parse(n3[1].clock) - (T0 + 70 * 60_000) - ((n3[1].ratio * 60) / 1.5) * 1000) < 2, "במהירות 1.5 השעון רץ מהר יותר מהשמע");

for (const p of await store.listPaths(`books/${book.id}/`)) await store.remove(p);
console.log("sleep ok");
