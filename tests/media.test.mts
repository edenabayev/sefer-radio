import { pcm16ToMp3, fakePcm } from "@/lib/mp3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfPageCount } from "@/lib/gemini";
import fs from "fs";

(async () => {
  const pcm = fakePcm(3);
  const mp3 = await pcm16ToMp3(pcm);
  console.log("pcm", pcm.length, "mp3", mp3.length, "ratio", (pcm.length / mp3.length).toFixed(1));
  if (mp3.length < 5000 || mp3[0] !== 0xff) throw new Error("mp3 looks wrong");
  fs.mkdirSync("tests/out", { recursive: true });
  fs.writeFileSync("tests/out/t.mp3", mp3);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage();
    page.drawText(`Page ${i} of the test document.`, { x: 50, y: 700, size: 18, font });
  }
  const bytes = Buffer.from(await doc.save());
  fs.writeFileSync("tests/out/t.pdf", bytes);
  console.log("pages", await pdfPageCount(bytes));
  if ((await pdfPageCount(bytes)) !== 3) throw new Error("page count");
  console.log("MEDIA TESTS OK");
})();
