// הספר כעץ: ספר → פרקים → קטעים עם מזהה קבוע. כל תוצר (תרגום, שמע, הסבר) נשמר לפי הקטע
// ונבדק לפני שמייצרים — "הזיכרון" של האפליקציה.
import crypto from "crypto";
import * as store from "./storage";
import { genText, tts, extractPdfPages, pdfPageCount, PDF_CHUNK_PAGES, VOICE, SAMPLE_RATE, askWithAudio } from "./gemini";
import { pcm16ToMp3 } from "./mp3";
import { buildSections, detectLang, epubToParagraphs, markdownToParagraphs, stripGutenberg, toParagraphs, type Chapter, type Section, type Lang } from "./text";

export interface Extraction {
  status: "pending" | "done" | "error";
  totalPages: number;
  nextPage: number; // העמוד הבא לחילוץ (1-based)
  markdown: string; // הטקסט שחולץ עד כה
  error?: string;
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  lang: Lang;
  source: { type: "gutenberg"; gid: number } | { type: "upload"; url: string; pathname?: string; filename: string; kind: "pdf" | "epub" | "txt" };
  createdAt: string;
  chapters: Chapter[];
  sections: Section[];
  extraction?: Extraction;
  summary?: string; // תקציר קצר לשימוש המורה
}

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  lang: Lang;
  sections: number;
  chapters: number;
  createdAt: string;
  extraction?: Pick<Extraction, "status" | "totalPages" | "nextPage" | "error">;
}

export interface Progress {
  section: number;
  offset: number; // שניות בתוך הקטע
  lang: "he" | "orig";
  study: boolean;
  updatedAt: string;
}

const P = {
  book: (id: string) => `books/${id}/book.json`,
  he: (id: string, i: number) => `books/${id}/he/${i}.txt`,
  audio: (id: string, i: number, lang: string, voice: string) => `books/${id}/audio/${lang}/${voice}/${i}.mp3`,
  explain: (id: string, i: number) => `books/${id}/explain/${i}.txt`,
  explainAudio: (id: string, i: number, voice: string) => `books/${id}/explain/${voice}/${i}.mp3`,
  progress: (id: string) => `books/${id}/progress.json`,
  answer: (id: string, i: number, hash: string) => `books/${id}/answers/${i}/${hash}.mp3`,
};

export function toMeta(b: Book): BookMeta {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    lang: b.lang,
    sections: b.sections.length,
    chapters: b.chapters.length,
    createdAt: b.createdAt,
    extraction: b.extraction ? { status: b.extraction.status, totalPages: b.extraction.totalPages, nextPage: b.extraction.nextPage, error: b.extraction.error } : undefined,
  };
}

export async function getBook(id: string): Promise<Book | null> {
  return store.readJSON<Book>(P.book(id));
}

async function saveBook(b: Book) {
  await store.writeJSON(P.book(b.id), b);
}

export async function listBooks(): Promise<BookMeta[]> {
  const paths = await store.listPaths("books/");
  const ids = paths.filter((p) => p.endsWith("/book.json")).map((p) => p.split("/")[1]);
  const books = await Promise.all(ids.map((id) => getBook(id)));
  return books
    .filter((b): b is Book => !!b)
    .map(toMeta)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteBook(id: string) {
  const paths = await store.listPaths(`books/${id}/`);
  await Promise.all(paths.map((p) => store.remove(p)));
}

function newId(seed: string) {
  return crypto.createHash("sha1").update(seed + Date.now()).digest("hex").slice(0, 12);
}

// ---------- מקור 1: גוטנברג ----------

export interface GutenbergHit {
  gid: number;
  title: string;
  author?: string;
  languages: string[];
  downloads: number;
  textUrl?: string;
}

export async function searchGutenberg(q: string): Promise<GutenbergHit[]> {
  const r = await fetch(`https://gutendex.com/books?search=${encodeURIComponent(q)}&copyright=false`, { headers: { "User-Agent": "sefer-radio (personal study app)" } });
  if (!r.ok) throw new Error("gutendex " + r.status);
  const j = (await r.json()) as { results: Array<{ id: number; title: string; authors: Array<{ name: string }>; languages: string[]; download_count: number; formats: Record<string, string> }> };
  return j.results.slice(0, 15).map((b) => ({
    gid: b.id,
    title: b.title,
    author: b.authors?.[0]?.name,
    languages: b.languages,
    downloads: b.download_count,
    textUrl: pickTextUrl(b.formats),
  }));
}

function pickTextUrl(formats: Record<string, string>): string | undefined {
  const keys = Object.keys(formats);
  const k = keys.find((k) => k.startsWith("text/plain") && k.includes("utf-8")) || keys.find((k) => k.startsWith("text/plain") && !formats[k].endsWith(".zip")) || keys.find((k) => k.startsWith("text/plain"));
  return k ? formats[k] : undefined;
}

export async function createFromGutenberg(gid: number): Promise<Book> {
  // אותו ספר שכבר נוצר? לא מייצרים שוב.
  const existing = (await listBooks()).find((m) => m.id === `g${gid}`);
  if (existing) return (await getBook(existing.id))!;

  const meta = await fetch(`https://gutendex.com/books/${gid}`, { headers: { "User-Agent": "sefer-radio (personal study app)" } });
  if (!meta.ok) throw new Error("gutendex " + meta.status);
  const j = (await meta.json()) as { title: string; authors: Array<{ name: string }>; languages: string[]; formats: Record<string, string> };
  let url = pickTextUrl(j.formats);
  if (!url) throw new Error("לספר הזה אין גרסת טקסט פשוט בגוטנברג");
  url = url.replace(/^http:/, "https:");
  const r = await fetch(url, { headers: { "User-Agent": "sefer-radio (personal study app)" } });
  if (!r.ok) throw new Error("gutenberg " + r.status);
  const raw = await r.text();
  const text = stripGutenberg(raw);
  const paras = toParagraphs(text);
  const { chapters, sections } = buildSections(paras);
  const book: Book = {
    id: `g${gid}`,
    title: j.title,
    author: j.authors?.[0]?.name,
    lang: (j.languages?.[0] === "he" ? "he" : j.languages?.[0] === "en" ? "en" : detectLang(text)) as Lang,
    source: { type: "gutenberg", gid },
    createdAt: new Date().toISOString(),
    chapters,
    sections,
  };
  await saveBook(book);
  return book;
}

// ---------- מקור 2: קובץ של המשתמש ----------

async function readSource(url: string, pathname?: string): Promise<Buffer> {
  if (pathname) {
    const b = await store.readBytes(pathname);
    if (b) return b;
  }
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

export async function createFromUpload(url: string, filename: string, pathname?: string): Promise<Book> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const kind: "pdf" | "epub" | "txt" = ext === "pdf" ? "pdf" : ext === "epub" ? "epub" : "txt";
  const data = await readSource(url, pathname);
  const id = "u" + newId(filename);
  const base: Omit<Book, "chapters" | "sections" | "lang"> = {
    id,
    title: filename.replace(/\.[^.]+$/, ""),
    source: { type: "upload", url, pathname, filename, kind },
    createdAt: new Date().toISOString(),
  };
  if (kind === "txt") {
    const text = data.toString("utf8");
    const { chapters, sections } = buildSections(toParagraphs(text));
    const book: Book = { ...base, lang: detectLang(text), chapters, sections };
    await saveBook(book);
    return book;
  }
  if (kind === "epub") {
    const e = await epubToParagraphs(data);
    const { chapters, sections } = buildSections(e.paragraphs);
    const book: Book = { ...base, title: e.title || base.title, author: e.author, lang: detectLang(e.paragraphs.join("\n")), chapters, sections };
    await saveBook(book);
    return book;
  }
  // PDF: נקרא עמוד-עמוד דרך Gemini, בצעדים (כל צעד = קריאה אחת לשרת)
  const totalPages = await pdfPageCount(data);
  const book: Book = {
    ...base,
    lang: "other",
    chapters: [],
    sections: [],
    extraction: { status: "pending", totalPages, nextPage: 1, markdown: "" },
  };
  await saveBook(book);
  return book;
}

/** צעד חילוץ אחד (עד PDF_CHUNK_PAGES עמודים). מחזיר את הספר המעודכן. */
export async function extractStep(id: string): Promise<Book> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  const ex = book.extraction;
  if (!ex || ex.status === "done") return book;
  if (book.source.type !== "upload") return book;
  const from = ex.nextPage;
  const to = Math.min(ex.totalPages, from + PDF_CHUNK_PAGES - 1);
  try {
    const pdf = await readSource(book.source.url, book.source.pathname);
    const md = await extractPdfPages(pdf, from, to);
    ex.markdown = (ex.markdown ? ex.markdown + "\n\n" : "") + md;
    ex.nextPage = to + 1;
    if (ex.nextPage > ex.totalPages) ex.status = "done";
    ex.error = undefined;
  } catch (e) {
    ex.status = "error";
    ex.error = String((e as Error)?.message || e);
  }
  // בונים מחדש את הקטעים מכל מה שחולץ עד כה — כך אפשר להתחיל להאזין לפני שהספר כולו נקרא
  const paras = markdownToParagraphs(ex.markdown);
  const built = buildSections(paras, book.title);
  book.chapters = built.chapters;
  book.sections = built.sections;
  if (book.lang === "other" && ex.markdown.length > 500) book.lang = detectLang(ex.markdown);
  // ex.markdown נשאר שמור בספר — כך לעולם לא מחלצים את אותו PDF פעמיים.
  await saveBook(book);
  return book;
}

// ---------- תרגום ----------

export async function ensureTranslation(book: Book, i: number): Promise<string> {
  const sec = book.sections[i];
  if (!sec) throw new Error("אין קטע " + i);
  if (book.lang === "he") return sec.text;
  const cached = await store.readText(P.he(book.id, i));
  if (cached) return cached;
  const prev = i > 0 ? book.sections[i - 1].text.slice(-600) : "";
  const system =
    "אתה מתרגם ספרותי מעולה לעברית. תרגם את הקטע לעברית טבעית, זורמת ומדויקת, בלשון ימינו, כמו ספר שיצא בהוצאה טובה. " +
    "שמור על חלוקת הפסקאות. אל תוסיף הערות, כותרות, ניקוד או הסברים — רק את התרגום. " +
    "אם הקטע הוא כותרת פרק בלבד, תרגם את הכותרת.";
  const prompt = (prev ? `(הקשר — סוף הקטע הקודם, לא לתרגם:)\n${prev}\n\n` : "") + `(הקטע לתרגום:)\n${sec.text}`;
  const he = await genText(prompt, system);
  await store.writeBytes(P.he(book.id, i), he, "text/plain; charset=utf-8");
  return he;
}

// ---------- שמע ----------

export interface AudioResult {
  url: string;
  text: string;
  lang: string;
  cached: boolean;
}

export async function ensureAudio(book: Book, i: number, lang: "he" | "orig", voice = VOICE): Promise<AudioResult> {
  const sec = book.sections[i];
  if (!sec) throw new Error("אין קטע " + i);
  const effLang = lang === "he" ? "he" : book.lang === "he" ? "he" : "en";
  const text = lang === "he" ? await ensureTranslation(book, i) : sec.text;
  const p = P.audio(book.id, i, effLang, voice);
  const url = await store.exists(p);
  if (url) return { url, text, lang: effLang, cached: true };
  const pcm = await tts(text, effLang, voice);
  const mp3 = await pcm16ToMp3(pcm, SAMPLE_RATE);
  const newUrl = await store.writeBytes(p, mp3, "audio/mpeg");
  return { url: newUrl, text, lang: effLang, cached: false };
}

// ---------- מצב לימוד ----------

export async function ensureSummary(book: Book): Promise<string> {
  if (book.summary) return book.summary;
  const sample = book.sections.slice(0, 6).map((s) => s.text).join("\n\n").slice(0, 12000);
  const sys = "כתוב בעברית, בלי ניקוד, בלי עיצוב.";
  const prompt = `זה תחילת הספר "${book.title}"${book.author ? ` מאת ${book.author}` : ""}. כתוב תקציר של 4-6 משפטים: מי המחבר, מתי ובאיזה הקשר נכתב, על מה הספר ומה חשוב לדעת לפני שמתחילים.\n\n${sample}`;
  const summary = await genText(prompt, sys, 1024);
  const fresh = await getBook(book.id);
  if (fresh) {
    fresh.summary = summary;
    await saveBook(fresh);
  }
  book.summary = summary;
  return summary;
}

export async function ensureExplanation(book: Book, i: number, voice = VOICE): Promise<{ text: string; url: string }> {
  const textPath = P.explain(book.id, i);
  const audioPath = P.explainAudio(book.id, i, voice);
  let text = await store.readText(textPath);
  if (!text) {
    const sec = book.sections[i];
    if (!sec) throw new Error("אין קטע " + i);
    const summary = await ensureSummary(book);
    const he = book.lang === "he" ? sec.text : await ensureTranslation(book, i);
    const chapter = book.chapters[sec.chapter]?.title ?? "";
    const system =
      "אתה מורה מצוין שמלמד ספר למאזין שנוהג ברכב. הוא שמע עכשיו את הקטע. " +
      "דבר בעברית מדוברת ובהירה, בלי ניקוד, בלי מילים לועזיות מיותרות, בלי סימני עיצוב ובלי רשימות — טקסט רציף להקראה בקול. " +
      "מבנה: משפט אחד שמנסח מחדש את עיקר הקטע; הקשר קצר (למה זה חשוב, מה קדם); שניים-שלושה רעיונות שכדאי לשים לב אליהם, עם דוגמה מהחיים אם זה עוזר; " +
      "ולסיום שאלה אחת למחשבה. אל תגלה מה קורה בהמשך הספר. בין 120 ל-220 מילים.";
    const prompt = `תקציר הספר: ${summary}\n\nפרק: ${chapter}\nקטע מספר ${i + 1} מתוך ${book.sections.length}.\n\nהקטע (בעברית):\n${he}\n\n${book.lang !== "he" ? `המקור:\n${sec.text}\n\n` : ""}עכשיו ההסבר של המורה:`;
    text = await genText(prompt, system, 2048);
    await store.writeBytes(textPath, text, "text/plain; charset=utf-8");
  }
  let url = await store.exists(audioPath);
  if (!url) {
    const pcm = await tts(text, "he", voice);
    url = await store.writeBytes(audioPath, await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
  }
  return { text, url };
}

export async function answerQuestion(book: Book, i: number, audio: Buffer, mimeType: string, voice = VOICE): Promise<{ text: string; url: string }> {
  const sec = book.sections[i];
  if (!sec) throw new Error("אין קטע " + i);
  const he = book.lang === "he" ? sec.text : (await store.readText(P.he(book.id, i))) ?? sec.text;
  const explain = (await store.readText(P.explain(book.id, i))) ?? "";
  const summary = book.summary ?? "";
  const context = `הספר: ${book.title}${book.author ? ` מאת ${book.author}` : ""}\n${summary}\n\nהקטע:\n${he}\n\n${explain ? `ההסבר שניתן:\n${explain}` : ""}`;
  const text = await askWithAudio(audio, mimeType, context);
  const hash = crypto.createHash("sha1").update(audio).digest("hex").slice(0, 10);
  const pcm = await tts(text, "he", voice);
  const url = await store.writeBytes(P.answer(book.id, i, hash), await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
  return { text, url };
}

// ---------- התקדמות ----------

export async function getProgress(id: string): Promise<Progress> {
  return (await store.readJSON<Progress>(P.progress(id))) ?? { section: 0, offset: 0, lang: "he", study: true, updatedAt: "" };
}

export async function setProgress(id: string, p: Partial<Progress>) {
  const cur = await getProgress(id);
  const next: Progress = { ...cur, ...p, updatedAt: new Date().toISOString() };
  await store.writeJSON(P.progress(id), next);
  return next;
}
