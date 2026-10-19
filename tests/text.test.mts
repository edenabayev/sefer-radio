import { stripGutenberg, toParagraphs, buildSections, detectLang, epubToParagraphs, markdownToParagraphs } from "@/lib/text";
import JSZip from "jszip";

const para = (n: number) => Array.from({ length: 6 }, (_, k) => `This is sentence ${k + 1} of paragraph ${n}, written to be long enough to matter for the section builder.`).join(" ");
let raw = "The Project Gutenberg eBook of Test\n\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n\nTEST BOOK\n\nby Nobody\n\n";
for (let c = 1; c <= 3; c++) {
  raw += `CHAPTER ${["I", "II", "III"][c - 1]}\n\n`;
  for (let p = 1; p <= 12; p++) raw += para(p).replace(/(.{70})\s/g, "$1\n") + "\n\n";
}
raw += "*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\nstuff";
const text = stripGutenberg(raw);
const paras = toParagraphs(text);
const b = buildSections(paras);
console.log("lang", detectLang(text), "paras", paras.length, "chapters", b.chapters.map((c) => `${c.title}[${c.start}-${c.end}]`), "sections", b.sections.length, "lens", b.sections.map((s) => s.text.length).slice(0, 8));
if (b.chapters.length !== 3) throw new Error("expected 3 chapters");
if (b.sections.some((s) => s.text.length > 2000)) throw new Error("section too long");
if (b.sections.some((s) => s.text.length < 250)) throw new Error("tiny section left");
if (b.sections.some((s) => s.text.includes("\n") && !s.text.includes("\n\n"))) throw new Error("hard line breaks left");

const heb = "פרק ראשון\n\n" + "זהו משפט בעברית שנכתב כדי לבדוק את החלוקה לקטעים. ".repeat(60) + "\n\nפרק שני\n\n" + "עוד משפט בעברית. ".repeat(100);
const hb = buildSections(toParagraphs(heb));
console.log("heb lang", detectLang(heb), "chapters", hb.chapters.map((c) => c.title), "sections", hb.sections.length);
if (detectLang(heb) !== "he" || hb.chapters.length !== 2) throw new Error("hebrew split failed");

const md = `## Chapter One\n\n${para(1)}\n\n${para(2)}\n\n${para(5)}\n\n## Chapter Two\n\n${para(3)}\n\n${para(4)}\n\n${para(6)}`;
const mp = buildSections(markdownToParagraphs(md));
console.log("md chapters", mp.chapters.map((c) => c.title));
if (mp.chapters.length !== 2 || mp.chapters[0].title !== "Chapter One") throw new Error("md headings failed");

(async () => {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
  zip.file("OEBPS/content.opf", `<package><metadata><dc:title>Epub Test</dc:title><dc:creator>Someone</dc:creator></metadata><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file("OEBPS/c1.xhtml", `<html><body><h1>Chapter 1</h1><p>${para(1)}</p><p>${para(2)}</p><p>${para(5)}</p></body></html>`);
  zip.file("OEBPS/c2.xhtml", `<html><body><h1>Chapter 2</h1><p>${para(3)}</p><p>${para(4)}</p><p>${para(6)}</p></body></html>`);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const e = await epubToParagraphs(buf);
  const eb = buildSections(e.paragraphs);
  console.log("epub", e.title, e.author, eb.chapters.map((c) => c.title), eb.sections.length);
  if (eb.chapters.length !== 2) throw new Error("epub chapters failed");
  console.log("ALL TEXT TESTS OK");
})();

// שורות דובר מחילוץ PDF אינן פרקים; פרקים זעירים מתאחדים
{
  const { buildSections: bs, markdownToParagraphs: mp2, isHeading } = await import("@/lib/text");
  const md = "## Chapter One\n\n" + "Intro text. ".repeat(150) + "\n\n## VASIṢṬHA said:\n\nRāma, listen. " + "More words here. ".repeat(100) + "\n\n## III:12 VASIṢṬHA continued:\n\n" + "Even more. ".repeat(100) + "\n\n## Chapter Two\n\n" + "Second chapter text. ".repeat(150);
  const b2 = bs(mp2(md));
  if (b2.chapters.length !== 2 || b2.chapters[1].title !== "Chapter Two") throw new Error("speaker lines must not become chapters: " + b2.chapters.map((c) => c.title).join(" | "));
  if (isHeading("# רמה שאל:")) throw new Error("hebrew speaker line");
  if (isHeading("# RĀMA said: III:11")) throw new Error("speaker line with verse ref");
  if (isHeading("# VASIṢṬHA asked Brahmā: III:92")) throw new Error("speaker line with addressee");
  if (!isHeading("# The Story of Kālarātri")) throw new Error("real heading");
  console.log("speaker-line test ok");
}
