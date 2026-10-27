// מייצר tests/fixtures/textlayer.pdf: ספר קטן עם שכבת טקסט (כותרת רצה, מספרי עמודים, כותרות פרקים, פסקאות עם הזחה)
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "fs";
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.TimesRoman);
const W = 420, H = 620, L = 45, size = 12, lh = 15, maxW = W - 2 * L;
const words = (n, k) => Array.from({ length: n }, (_, i) => ["river", "stone", "garden", "lantern", "harbor", "violet", "morning", "window"][(i + k) % 8]).join(" ");
const chapters = [1, 2, 3].map((c) => ({
  title: `Chapter ${c}`,
  paras: Array.from({ length: 9 }, (_, k) => `Paragraph ${c}.${k + 1} begins here. ` + words(40 + (k % 3) * 15, k + c) + ` and so ends paragraph ${c}.${k + 1}.`),
}));
let page = null, y = 0, n = 0;
const newPage = () => {
  page = doc.addPage([W, H]);
  n++;
  page.drawText("THE TEXT LAYER BOOK", { x: 140, y: H - 30, size: 9, font });
  page.drawText(String(n), { x: W / 2 - 3, y: 25, size: 9, font });
  y = H - 70;
};
for (const ch of chapters) {
  newPage();
  page.drawText(ch.title, { x: 150, y, size: 20, font });
  y -= 40;
  for (const p of ch.paras) {
    let line = "", first = true;
    const flushLine = (last) => {
      if (y < 50) newPage();
      page.drawText(line, { x: L + (first ? 18 : 0), y, size, font });
      y -= lh;
      first = false;
      line = "";
    };
    for (const w of p.split(" ")) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW - (first ? 18 : 0)) flushLine(false), (line = w);
      else line = t;
    }
    if (line) flushLine(true);
  }
}
writeFileSync(new URL("../tests/fixtures/textlayer.pdf", import.meta.url), await doc.save());
console.log("pages", n);
