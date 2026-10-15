// צינור ההקראה: ניקוי, משפטים, חתיכות, שקט והפסקות.
process.env.MOCK_AI = "1";
import assert from "node:assert/strict";
import { normalizeForSpeech, sentences, planChunks, trimSilence, pauseSeconds, narrate, numberToWords, yearToWords } from "../src/lib/narrate";

// ניקוי אנגלית
const n = normalizeForSpeech("Mr. Spencer paid $1,250.50 on the 3rd of May, 1951 — at 9:05 a.m. The U.S. Army had 3.5 million men.\nSame paragraph.\n\nNew paragraph…", "en");
assert.ok(n.includes("Mister Spencer"), n);
assert.ok(n.includes("one thousand two hundred fifty dollars and fifty cents"), n);
assert.ok(n.includes("third of May"), n);
assert.ok(n.includes("nineteen fifty-one"), n);
assert.ok(n.includes("nine oh five A M"), n);
assert.ok(n.includes("U S Army"), n);
assert.ok(n.includes("three point five million"), n);
assert.ok(n.includes("men. Same paragraph.") && n.includes("\n\nNew paragraph..."), n);
assert.ok(!n.includes("—"), n);
assert.equal(numberToWords(1000000), "one million");
assert.equal(numberToWords(342), "three hundred forty-two");
assert.equal(yearToWords(2008), "two thousand eight");
assert.equal(yearToWords(1900), "nineteen hundred");
assert.equal(yearToWords(2024), "twenty twenty-four");

// משפטים — קיצורים לא שוברים משפט
const ss = sentences('Mr. Holden said, "Come in." He went in! Really? The U.S. Army was big. No. 5 was next.', "en");
assert.deepEqual(ss, ['Mr. Holden said, "Come in."', "He went in!", "Really?", "The U.S. Army was big.", "No. 5 was next."]);
const hs = sentences("אמר המלך: לכו. והם הלכו! האם חזרו? לא.", "he");
assert.deepEqual(hs, ["אמר המלך: לכו.", "והם הלכו!", "האם חזרו?", "לא."]);

// חתיכות: לא חותכים משפט, מסמנים גבולות
const text = ["One. Two two two. Three three three three.", "Four four. Five.", "Six."].join("\n\n");
const plan = planChunks(text, "en", { targetChars: 20, maxChars: 60 });
assert.deepEqual(plan.map((c) => [c.text, c.after]), [
  ["One. Two two two.", "sentence"],
  ["Three three three three.", "paragraph"],
  ["Four four. Five.", "paragraph"],
  ["Six.", "end"],
]);
// משפט ענק נחתך בפסיק, עם גבול "כפוי" (בלי הפסקה)
const long = "a".repeat(30) + ", " + "b".repeat(30) + ", " + "c".repeat(30) + ".";
const p2 = planChunks(long, "en", { targetChars: 40, maxChars: 50 });
assert.equal(p2.length, 3);
assert.equal(p2[0].after, "forced");
assert.equal(p2[1].after, "forced");
assert.equal(p2[2].after, "end");
assert.equal(pauseSeconds("forced"), 0);
// כותרת ראשונה
const p3 = planChunks("Chapter One\n\nText here. More text.", "en", { targetChars: 300, maxChars: 400 }, { headingFirst: true });
assert.deepEqual(p3.map((c) => [c.text, c.after]), [["Chapter One", "heading"], ["Text here. More text.", "end"]]);
// מדידה בבייטים (עברית)
const heb = planChunks("שָׁלוֹם עוֹלָם. " .repeat(40), "he", { targetChars: 300, maxChars: 400, measure: (s) => Buffer.byteLength(s, "utf8") });
assert.ok(heb.every((c) => Buffer.byteLength(c.text, "utf8") <= 400), "byte budget");

// שקט: 0.5 שניות שקט + טון + 0.5 שקט → נשאר הטון עם שוליים
const rate = 24000;
const tone = Buffer.alloc(rate * 2);
for (let i = 0; i < rate; i++) tone.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
const padded = Buffer.concat([Buffer.alloc(rate), tone, Buffer.alloc(rate)]);
const trimmed = trimSilence(padded);
assert.ok(trimmed.length >= tone.length && trimmed.length <= tone.length + 2 * 0.07 * rate * 2, String(trimmed.length));

// הצינור השלם: 2 חתיכות + הפסקות
const out = await narrate("Hello there. Bye.\n\nNext.", "en", { targetChars: 8, maxChars: 60 }, async () => tone);
const expectedMin = 3 * tone.length + (0.25 + 0.7 + 0.35) * rate * 2 - 10;
assert.ok(out.length >= expectedMin, `${out.length} >= ${expectedMin}`);
console.log("narrate ok");
