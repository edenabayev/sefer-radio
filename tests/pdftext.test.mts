// קריאת PDF עם שכבת טקסט על השרת: כותרות, פסקאות (הזחה/רווח), פסקה שנמשכת לעמוד הבא, מקף בסוף שורה,
// מספרי עמודים וכותרת רצה — ושחזור צירופי אותיות (fi/ff/fl) שנעלמו.
process.env.MOCK_AI = "1";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfText, repairLigatures, fixDropCaps, isHebrewText } from "../src/lib/pdftext";

// ---------- צירופי אותיות ----------
const Z = "\u0000";
assert.equal(repairLigatures(`the ${Z}sherman’s ${Z}rst catch was di${Z}erent, o${Z} the ${Z}re${Z}y.`), "the fisherman’s first catch was different, off the firefly.");
assert.equal(repairLigatures(`Ja${Z}a and ${Z}owers`), "Jaffa and flowers", "שם לא מוכר בין תנועות → ff; flowers מהרשימה");
assert.equal(repairLigatures("eﬀect ﬁne"), "effect fine", "צירופים ביוניקוד");
assert.equal(repairLigatures("plain text"), "plain text");
assert.equal(isHebrewText("שלום עולם hello"), true);
assert.equal(await fixDropCaps("## Title\n\nt is said"), "## Title\n\nt is said", "במצב דמה — בלי שינוי");

// ---------- PDF אמיתי (נוצר כאן) ----------
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.TimesRoman);
const W = 400, H = 600, L = 40, size = 12, lh = 15;
const lines1: [string, number][] = [
  ["Chapter One", 0],
  ["It was a dark night and the wind was blowing across", 1],
  ["the moors. Nobody went out that evening.", 0],
  ["The next morning the village woke to a strange sight. The", 1],
  ["old well had filled with clear water, and every child", 0],
  ["came running to see it. Nobody could explain how it had hap-", 0],
];
const lines2: [string, number][] = [
  ["pened, and the elders argued about it for days without", 0],
  ["reaching any answer.", 0],
  ["Later that spring the rains came.", 1],
];
function page(lines: [string, number][], n: number) {
  const p = doc.addPage([W, H]);
  p.drawText("A TEST BOOK", { x: 150, y: 570, size: 9, font }); // כותרת רצה
  let y = 520;
  for (const [t, indent] of lines) {
    if (t === "Chapter One") {
      p.drawText(t, { x: 140, y, size: 20, font });
      y -= 40;
      continue;
    }
    p.drawText(t, { x: L + (indent ? 18 : 0), y, size, font });
    y -= lh;
  }
  p.drawText(String(n), { x: 195, y: 30, size: 9, font }); // מספר עמוד
}
page(lines1, 1);
page(lines2, 2);
for (let n = 3; n <= 4; n++) page([["Filler paragraph number " + n + " goes here and continues.", 1]], n);
const bytes = await doc.save();
const r = await extractPdfText(Buffer.from(bytes), 1, 4);
const paras = r.markdown.split("\n\n");
assert.equal(paras[0], "## Chapter One");
assert.equal(paras[1], "It was a dark night and the wind was blowing across the moors. Nobody went out that evening.");
assert.equal(
  paras[2],
  "The next morning the village woke to a strange sight. The old well had filled with clear water, and every child came running to see it. Nobody could explain how it had happened, and the elders argued about it for days without reaching any answer.",
  "פסקה שנמשכת לעמוד הבא + מקף בסוף שורה",
);
assert.equal(paras[3], "Later that spring the rains came.");
assert.ok(!r.markdown.includes("A TEST BOOK"), "כותרת רצה נזרקה");
assert.ok(!/(^|\n)\d+(\n|$)/.test(r.markdown), "מספרי עמודים נזרקו");
assert.equal(r.pages, 4);
// ספר קטן עם "Chapter N" בראש עמוד — כותרות פרק (לא "כותרת רצה"), 27 פסקאות, בלי הכותרת הרצה ומספרי העמודים
{
  const { readFileSync } = await import("fs");
  const t = await extractPdfText(readFileSync("tests/fixtures/textlayer.pdf"), 1, 100);
  const ps = t.markdown.split("\n\n");
  assert.deepEqual(ps.filter((p) => p.startsWith("## ")), ["## Chapter 1", "## Chapter 2", "## Chapter 3"]);
  assert.equal(ps.filter((p) => p.startsWith("Paragraph")).length, 27);
  assert.ok(ps.every((p) => p.startsWith("## ") || /^Paragraph \d\.\d+ begins here\..*and so ends paragraph \d\.\d+\.$/.test(p)), "כל פסקה שלמה");
  assert.ok(!t.markdown.includes("TEXT LAYER BOOK"));
}
console.log("pdftext ok");
