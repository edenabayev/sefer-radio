// כרטיס תרגום: זיהוי שמות חוזרים, מילון (טקסט ↔ רשומות), הנחיות למתרגם, דורות תרגום ונתיבים, ומחקר במצב דמה.
process.env.MOCK_AI = "1";
delete process.env.BLOB_READ_WRITE_TOKEN;
import assert from "node:assert/strict";
import * as store from "../src/lib/storage";
import {
  candidateNames,
  parseGlossary,
  glossaryToText,
  relevantGlossary,
  translationPrompt,
  styleSample,
  latestCard,
  cardStatus,
  researchCard,
  beginResearch,
  ensureCard,
  editCard,
  AlreadyResearching,
  normalizeCard,
  verifyNotes,
} from "../src/lib/translation";
import { getBook, saveBook, newTrGen, readTrGen, translationStats, ensureTranslation, cleanTranslation, heDir, heTextPath, heMapPath, trSuffix, type Book } from "../src/lib/books";
import { audioDirFor, questionDirFor, heTexts } from "../src/lib/prepare";

// ---------- שמות חוזרים ----------
const story = [
  "Anyway, I went over to see old Benny. Benny was sitting on his bed at Pemberton Academy, reading. Marcus Lane came in and said Benny was a phony. " +
    "I told Marcus that Benny was all right. Then Mr. Hollis yelled at us. Mr. Hollis was the housemaster, and he hated Marcus.",
  "The next day D.J. called me. D.J. was my brother and he lived in Chicago. I wanted to tell D.J. about Pemberton Academy and old Benny, but anyway I didn't. " +
    "Marcus Lane was there too, and Marcus asked about Chicago. It was a Sunday, and Benny went to church.",
  "Benny said Marcus was a moron. I said anyway, Marcus is OK. The trouble with Marcus is that he talks too much. Then we went to Chicago and saw Mr. Hollis again.",
];
const names = candidateNames(story);
const got = names.map((n) => n.name);
for (const want of ["Benny", "Marcus", "Chicago", "Marcus Lane", "Pemberton Academy", "Mr. Hollis", "D.J."]) assert.ok(got.includes(want), `צריך למצוא ${want}: ${got.join(", ")}`);
for (const no of ["Anyway", "The", "Then", "I", "Sunday", "It", "OK"]) assert.ok(!got.includes(no), `${no} הוא לא שם: ${got.join(", ")}`);
assert.ok(names[0].count >= names[names.length - 1].count, "ממוין לפי שכיחות");
// חלק משם מורכב לא נכנס לבד: "York" מתוך "New York"
const ny = candidateNames(["We drove to New York and then New York again. I hate New York, and New York hates me. Phil lived in New York."]).map((n) => n.name);
assert.ok(ny.includes("New York") && !ny.includes("York"), ny.join(", "));

// ---------- מילון: טקסט ↔ רשומות ----------
const gl = parseGlossary("Holden Caulfield = הולדן קולפילד // לפי התרגום\nphony → מזויף\n  Pencey -> פנסי  \nשורה בלי סימן\nphony = כפול\n\nD.B. — די.בי.");
assert.deepEqual(gl, [
  { en: "Holden Caulfield", he: "הולדן קולפילד", note: "לפי התרגום" },
  { en: "phony", he: "מזויף" },
  { en: "Pencey", he: "פנסי" },
  { en: "D.B.", he: "די.בי." },
]);
assert.deepEqual(parseGlossary(glossaryToText(gl)), gl, "הלוך-חזור בלי איבוד");

// ---------- מה רלוונטי לקטע ----------
const rel = relevantGlossary(gl, "Old Holden said the whole thing was phony. I went to see D.B. in Hollywood.");
assert.deepEqual(rel.map((g) => g.en), ["Holden Caulfield", "phony", "D.B."], "שם מלא נכנס גם כשמופיע רק חלק ממנו; פנסי לא מופיע");
assert.equal(relevantGlossary(gl, "phonyness and Penceys").length, 0, "רק מילים שלמות");

// ---------- ההנחיות למתרגם ----------
const book: Book = {
  id: "test-tcard",
  title: "Test Story",
  author: "Somebody",
  lang: "en",
  source: { type: "upload", url: "x", filename: "x.txt", kind: "txt" },
  createdAt: new Date().toISOString(),
  chapters: [{ title: "1", start: 0, end: 2 }],
  sections: story.map((text, i) => ({ i, chapter: 0, text })),
};
const card0 = {
  id: "1",
  createdAt: new Date().toISOString(),
  source: "research" as const,
  translations: [{ translator: "מתרגם", year: "2005" }],
  model: "התרגום של מתרגם (2005)",
  approach: "מדובר",
  instructions: "עברית מדוברת\n- בלי מילים גבוהות",
  glossary: [
    { en: "Marcus Lane", he: "מרקוס ליין" },
    { en: "phony", he: "מזויף" },
    { en: "Chicago", he: "שיקגו" },
  ],
  confidence: "high" as const,
  sources: [],
};
const tp = translationPrompt(book, 1, card0, "סוף התרגום הקודם.");
assert.ok(tp.system.includes("ברוח התרגום של מתרגם (2005)"));
assert.ok(tp.system.includes("- עברית מדוברת") && tp.system.includes("- בלי מילים גבוהות"), "כל שורה הופכת להנחיה");
assert.ok(tp.system.includes("Marcus Lane = מרקוס ליין") && tp.system.includes("Chicago = שיקגו"), "ערכים שמופיעים בקטע");
assert.ok(!tp.system.includes("phony = מזויף"), "ערך שלא מופיע בקטע הזה לא נשלח");
assert.ok(tp.system.includes("אל תשחזר"), "חיקוי סגנון, לא העתקה");
assert.ok(tp.prompt.includes("סוף התרגום הקודם.") && tp.prompt.includes("(הקטע לתרגום:)\n" + story[1]));
// פסקה שנשברה באמצע משפט (מעבר עמוד ב-PDF) מגיעה למתרגם מחוברת, בלי רווחים כפולים
const broken: Book = { ...book, sections: [{ i: 0, chapter: 0, text: "It cost  quite a penny. But it was a\n\nfunny thing. Here is what happened.\n\nThe next day he left." }] };
const bp = translationPrompt(broken, 0, null, null).prompt;
assert.ok(bp.includes("But it was a funny thing. Here is what happened.\n\nThe next day he left."), bp);
assert.ok(bp.includes("cost quite a penny"), "רווח כפול מה-PDF");
const noCard = translationPrompt(book, 0, null, null);
assert.ok(!noCard.system.includes("כרטיס") && !noCard.prompt.includes("הקשר"), "בלי כרטיס ובלי הקשר בקטע הראשון");
assert.ok(styleSample(book).startsWith("Anyway"), "דוגמת סגנון מתחילת הספר");

// ---------- ניקוי תשובת המודל ----------
assert.equal(cleanTranslation("הנה התרגום:\nשלום עולם"), "שלום עולם");
assert.equal(cleanTranslation("```\nשלום\n\nעולם\n```"), "שלום\n\nעולם");
assert.equal(cleanTranslation("(הקטע לתרגום:)\nשלום"), "שלום");

// ---------- נרמול תשובת ה-JSON ----------
const norm = normalizeCard({
  translations: [{ translator: " דניאל " }, { translator: "" }],
  approach: "גישה",
  instructions: ["א", " ", "ב"],
  glossary: [{ en: "Holden", he: "הולדן" }, { en: "holden", he: "כפול" }, { en: "", he: "ריק" }],
  confidence: "weird",
});
assert.equal(norm.instructions, "א\nב");
assert.deepEqual(norm.glossary, [{ en: "Holden", he: "הולדן" }]);
assert.equal(norm.translations.length, 1);
assert.equal(norm.confidence, "medium");

// "לפי התרגום של…" רק כשהצורה העברית מופיעה בדוח
const vn = verifyNotes(
  [
    { en: "phony", he: "מזויף", note: "לפי התרגום של X" },
    { en: "for God's sake", he: "בחייאת", note: "לפי התרגום של X" },
    { en: "Holden", he: "הולדן", note: "הצעה" },
    { en: "goddam", he: "דפוק", note: "לפי התרגום של X" },
  ],
  "בתרגום של X, phony תורגם כ'מזויף'. היא משתמשת גם במילה 'דפוק'.",
);
assert.deepEqual(vn.map((g) => g.note), ["לפי התרגום של X", "הצעה ברוח התרגום", "הצעה", "הצעה ברוח התרגום"], "צריך גם את הצורה במקור בדוח");

// ---------- נתיבים ודורות ----------
assert.equal(heDir(book), "books/test-tcard/he/");
assert.equal(heMapPath(book), "books/test-tcard/he.json");
assert.equal(trSuffix({ lang: "he", trGen: "5" }), "", "ספר עברי — אין דורות תרגום");
const g5 = { ...book, trGen: "5" };
assert.equal(heTextPath(g5, 3), "books/test-tcard/he-5/3.txt");
assert.equal(heMapPath(g5), "books/test-tcard/he-5.json");
assert.ok(audioDirFor(g5, "Puck", "he").endsWith("-t5/"), "שמע עברי בדור חדש — תיקייה חדשה");
assert.ok(!audioDirFor(g5, "am_michael", "en").includes("-t5"), "שמע במקור לא תלוי בתרגום");
assert.ok(questionDirFor(g5, "Puck").endsWith("-p6-t5/"));

// ---------- מחקר, עריכה, דור חדש (אחסון מקומי, מצב דמה) ----------
for (const p of await store.listPaths(`books/${book.id}/`)) await store.remove(p);
await saveBook(book);
assert.equal((await cardStatus(book.id)).state, "none");

// מחקר שרץ — מחקר שני מוותר
const run = await beginResearch(book.id);
assert.equal((await cardStatus(book.id)).state, "researching");
await assert.rejects(() => beginResearch(book.id, Number(run) + 1000), AlreadyResearching);
const card1 = await researchCard(book, run);
assert.equal((await cardStatus(book.id)).state, "ready");
assert.equal((await latestCard(book.id))?.id, card1.id);
assert.ok(card1.glossary.some((g) => g.en === "Marcus"), "המילון בדמה נבנה מהשמות שנמצאו");
assert.ok(card1.sources.length >= 1 && card1.report);

// ensureCard: כרטיס קיים — בלי מחקר חדש
const before = (await store.listPaths(`books/${book.id}/tcard-run/`)).length;
assert.equal((await ensureCard(book))?.id, card1.id);
assert.equal((await store.listPaths(`books/${book.id}/tcard-run/`)).length, before);

// תרגום לפני עריכה (דור ראשון)
const fresh = (await getBook(book.id))!;
assert.equal(fresh.trGen, undefined);
await ensureTranslation(fresh, 0);
assert.ok(await store.readText("books/test-tcard/he/0.txt"), "תרגום בנתיב המקורי");
await new Promise((r) => setTimeout(r, 30));

// עריכה → גרסה חדשה; התרגום הקודם נחשב "ישן"
const edited = await editCard(book.id, { instructions: "הנחיה חדשה", glossaryText: "Marcus = מרקוס" });
assert.equal(edited.source, "edit");
assert.equal((await latestCard(book.id))?.instructions, "הנחיה חדשה");
assert.deepEqual((await latestCard(book.id))?.glossary, [{ en: "Marcus", he: "מרקוס" }]);
assert.equal(edited.report, card1.report, "העריכה שומרת את המחקר");
const st1 = await translationStats(fresh, edited.createdAt);
assert.deepEqual(st1, { translated: 1, older: 1 });

// "תרגם מחדש לפי הכרטיס" → דור חדש: נתיבים חדשים, הישן נשאר בצד
await new Promise((r) => setTimeout(r, 5));
const gen = await newTrGen(book.id, edited.id);
assert.equal(await readTrGen(book.id), gen);
const g = (await getBook(book.id))!;
assert.equal(g.trGen, gen, "getBook קורא את הדור מקובצי הסימון");
assert.deepEqual(await translationStats(g, edited.createdAt), { translated: 0, older: 0 });
await ensureTranslation(g, 1);
assert.ok(await store.readText(`books/test-tcard/he-${gen}/1.txt`), "תרגום בדור החדש");
assert.ok(await store.readText("books/test-tcard/he/0.txt"), "התרגום הישן לא נמחק");
assert.equal((await heTexts(g, [0, 1]))[0], undefined, "הדור החדש לא רואה את התרגום הישן");
// book.json לא שומר את הדור (הוא נקרא מקבצי הסימון)
await saveBook(g);
assert.equal(JSON.parse((await store.readText(`books/${book.id}/book.json`))!).trGen, undefined);

// דוגמה (save:false) — לא נשמרת
await ensureTranslation(g, 2, { save: false });
assert.equal(await store.readText(`books/test-tcard/he-${gen}/2.txt`), null);

// ספר עברי — אין כרטיס
assert.equal(await ensureCard({ ...book, lang: "he" }), null);

// כישלון מחקר לאחרונה → לא מנסים שוב לבד (מתרגמים בלי כרטיס)
const other: Book = { ...book, id: "test-tcard-fail" };
for (const p of await store.listPaths(`books/${other.id}/`)) await store.remove(p);
const failedRun = Date.now() - 1000;
await store.writeJSON(`books/${other.id}/tcard-run/${failedRun}.start.json`, {});
await store.writeJSON(`books/${other.id}/tcard-run/${failedRun}.fail.json`, { at: new Date().toISOString(), error: "בדיקה" });
const fst = await cardStatus(other.id);
assert.equal(fst.state, "error");
assert.equal(await ensureCard(other, { wait: true }), null);
assert.equal((await store.listPaths(`books/${other.id}/tcard/`)).length, 0, "לא נעשה מחקר חדש");

for (const id of [book.id, other.id]) for (const p of await store.listPaths(`books/${id}/`)) await store.remove(p);
console.log("translation ok");
