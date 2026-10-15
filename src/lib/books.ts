// הספר כעץ: ספר → פרקים → קטעים עם מזהה קבוע. כל תוצר (תרגום, שמע, הסבר) נשמר לפי הקטע
// ונבדק לפני שמייצרים — "הזיכרון" של האפליקציה.
import crypto from "crypto";
import * as store from "./storage";
import { fetchWithMirrors, loadCatalog, searchCatalog, GUT_UA } from "./catalog";
import { genText, tts, extractPdfPages, pdfPageCount, PDF_CHUNK_PAGES, VOICE, SAMPLE_RATE, askWithAudio, TTS_VERSION } from "./gemini";
import { KOKORO_VERSION, kokoroVoice } from "./kokoro-voices";
import { pcm16ToMp3 } from "./mp3";
import { buildSections, cleanSourceText, cleanSourceParagraphs, detectLang, epubToParagraphs, markdownToParagraphs, stripGutenberg, toParagraphs, type Chapter, type Section, type Lang } from "./text";

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
  source:
    | { type: "gutenberg"; gid: number }
    | { type: "archive"; identifier: string; url?: string; pathname?: string; kind?: "pdf" | "txt" }
    | { type: "upload"; url: string; pathname?: string; filename: string; kind: "pdf" | "epub" | "txt" };
  createdAt: string;
  chapters: Chapter[];
  sections: Section[];
  extraction?: Extraction;
  summary?: string; // תקציר קצר לשימוש המורה
  background?: string; // כרטיס רקע לשיחה: מחבר, תקופה, רעיונות, התקבלות — נוצר פעם אחת ע"י המוח הגדול
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
  progress?: { section: number; updatedAt: string };
}

export interface Progress {
  section: number;
  offset: number; // שניות בתוך הקטע
  lang: "he" | "orig";
  study: boolean; // מצב לימוד שקט: תקציר בחזרה + שאלה בסוף פרק
  voice?: string; // קול עברי (Gemini)
  voiceEn?: string; // קול אנגלי (Kokoro) להאזנה במקור
  rate?: number;
  startedAt?: string; // ▶ ראשון — לפני זה לא מכינים כלום (כלל עדן: שום דבר לא נוצר סתם)
  updatedAt: string;
}

const P = {
  book: (id: string) => `books/${id}/book.json`,
  he: (id: string, i: number) => `books/${id}/he/${i}.txt`,
  audio: (id: string, i: number, lang: string, voice: string) => `books/${id}/audio/${lang}/${voice}-${lang === "en" ? KOKORO_VERSION : TTS_VERSION}/${i}.mp3`,
  explain: (id: string, i: number) => `books/${id}/explain/${i}.txt`,
  explainAudio: (id: string, i: number, voice: string) => `books/${id}/explain/${voice}-${TTS_VERSION}/${i}.mp3`,
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

export async function saveBook(b: Book) {
  await store.writeJSON(P.book(b.id), b);
}

export async function listBooks(): Promise<BookMeta[]> {
  const paths = await store.listPaths("books/");
  const ids = paths.filter((p) => p.endsWith("/book.json")).map((p) => p.split("/")[1]);
  const books = await Promise.all(ids.map((id) => getBook(id)));
  const metas = await Promise.all(
    books
      .filter((b): b is Book => !!b)
      .map(async (b) => {
        const p = await getProgress(b.id);
        return { ...toMeta(b), progress: p.updatedAt ? { section: p.section, updatedAt: p.updatedAt } : undefined };
      }),
  );
  return metas.sort((a, b) => ((a.progress?.updatedAt || a.createdAt) < (b.progress?.updatedAt || b.createdAt) ? 1 : -1));
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


function xmlText(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim() : undefined;
}

/** חיפוש: קודם בקטלוג המקומי (מהיר ויציב), ואם אין — בקטלוג ה-OPDS של גוטנברג (gutendex חסום לשרתים). */
export async function searchGutenberg(q: string): Promise<GutenbergHit[]> {
  const catalog = await loadCatalog();
  if (catalog) {
    return searchCatalog(catalog, q).map((e) => ({ gid: e.gid, title: e.title, author: e.author || undefined, languages: [e.lang], downloads: 0, textUrl: gutenbergTextUrl(e.gid) }));
  }
  return searchGutenbergOpds(q);
}

export async function searchGutenbergOpds(q: string): Promise<GutenbergHit[]> {
  const r = await fetchWithMirrors([`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}`]);
  const xml = await r.text();
  const entries = xml.split("<entry>").slice(1);
  const hits: GutenbergHit[] = [];
  for (const e of entries) {
    const idm = e.match(/<id>[^<]*\/ebooks\/(\d+)/) || e.match(/urn:gutenberg:(\d+)/) || e.match(/\/ebooks\/(\d+)\.opds/);
    if (!idm) continue;
    const gid = Number(idm[1]);
    if (hits.some((h) => h.gid === gid)) continue;
    const title = xmlText(e, "title") || `#${gid}`;
    // בפיד של גוטנברג שם המחבר יושב ב-<content>, לא ב-<author>
    const author = xmlText(e, "name") || xmlText(e, "content");
    const lang = xmlText(e, "dcterms:language") || "";
    hits.push({ gid, title, author, languages: lang ? [lang.toLowerCase().slice(0, 2)] : [], downloads: 0, textUrl: gutenbergTextUrl(gid) });
    if (hits.length >= 15) break;
  }
  return hits;
}

function gutenbergTextUrl(gid: number) {
  return `https://www.gutenberg.org/cache/epub/${gid}/pg${gid}.txt`;
}

export async function createFromGutenberg(gid: number, hint?: { title?: string; author?: string; lang?: string }): Promise<Book> {
  // אותו ספר שכבר נוצר? לא מייצרים שוב.
  const existing = await getBook(`g${gid}`);
  if (existing) return existing;

  const r = await fetchWithMirrors([
    gutenbergTextUrl(gid),
    `https://gutenberg.pglaf.org/cache/epub/${gid}/pg${gid}.txt`,
    `https://aleph.gutenberg.org/cache/epub/${gid}/pg${gid}.txt`,
    `https://www.gutenberg.org/ebooks/${gid}.txt.utf-8`,
  ]);
  const raw = await r.text();
  const header = raw.slice(0, 4000);
  const title = hint?.title || header.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || `Gutenberg #${gid}`;
  const author = hint?.author || header.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
  const langHeader = header.match(/^Language:\s*(.+)$/m)?.[1]?.trim().toLowerCase();
  const text = stripGutenberg(raw);
  const paras = toParagraphs(text);
  const { chapters, sections } = buildSections(paras);
  const langGuess = hint?.lang || (langHeader?.startsWith("hebrew") ? "he" : langHeader?.startsWith("english") ? "en" : "");
  const book: Book = {
    id: `g${gid}`,
    title,
    author,
    lang: (langGuess === "he" ? "he" : langGuess === "en" ? "en" : detectLang(text)) as Lang,
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

export async function createFromUpload(url: string, filename: string, pathname?: string, meta?: { id?: string; title?: string; author?: string }): Promise<Book> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const kind: "pdf" | "epub" | "txt" = ext === "pdf" ? "pdf" : ext === "epub" ? "epub" : "txt";
  const data = await readSource(url, pathname);
  const id = meta?.id || "u" + newId(filename);
  const base: Omit<Book, "chapters" | "sections" | "lang"> = {
    id,
    title: meta?.title || filename.replace(/\.[^.]+$/, ""),
    author: meta?.author,
    source: { type: "upload", url, pathname, filename, kind },
    createdAt: new Date().toISOString(),
  };
  if (kind === "txt") {
    const text = cleanSourceText(data.toString("utf8"));
    const { chapters, sections } = buildSections(toParagraphs(text));
    const book: Book = { ...base, lang: detectLang(text), chapters, sections };
    await saveBook(book);
    return book;
  }
  if (kind === "epub") {
    const e = await epubToParagraphs(data);
    e.paragraphs = cleanSourceParagraphs(e.paragraphs);
    const { chapters, sections } = buildSections(e.paragraphs);
    const book: Book = { ...base, title: meta?.title || e.title || base.title, author: meta?.author || e.author, lang: detectLang(e.paragraphs.join("\n")), chapters, sections };
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

/** בנייה מחדש של הקטעים מקובץ המקור (אחרי שיפור בניקוי/חלוקה). שומר את המזהה; שמע ותרגום ישנים נשארים לפי מספר קטע. */
export async function rebuildBook(id: string): Promise<Book> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  if (book.source.type !== "upload" || book.source.kind === "pdf") return book;
  const data = await readSource(book.source.url, book.source.pathname);
  if (book.source.kind === "txt") {
    const text = cleanSourceText(data.toString("utf8"));
    const b = buildSections(toParagraphs(text));
    book.chapters = b.chapters;
    book.sections = b.sections;
    book.lang = detectLang(text);
  } else {
    const e = await epubToParagraphs(data);
    const b = buildSections(cleanSourceParagraphs(e.paragraphs));
    book.chapters = b.chapters;
    book.sections = b.sections;
  }
  await saveBook(book);
  return book;
}

/** צעד חילוץ אחד (עד PDF_CHUNK_PAGES עמודים). מחזיר את הספר המעודכן. */
export async function extractStep(id: string): Promise<Book> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  const ex = book.extraction;
  if (!ex || ex.status === "done") return book;
  if (book.source.type === "gutenberg" || !book.source.url) return book;
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
  if (effLang === "en") voice = kokoroVoice(voice);
  const p = P.audio(book.id, i, effLang, voice);
  const url = await store.exists(p);
  if (url) return { url, text, lang: effLang, cached: true };
  // אנגלית: Kokoro (קוד פתוח, רץ כאן על המעבד, בלי עלות לפי תו). עברית: Gemini.
  const pcm = effLang === "en" ? (await (await import("./kokoro")).kokoroTts(text, voice)).pcm : await tts(text, effLang, voice);
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
  const p = (await store.readJSON<Progress>(P.progress(id))) ?? { section: 0, offset: 0, lang: "he", study: true, updatedAt: "" };
  // ספרים שנשמעו לפני שהכלל "כלום לפני ▶ ראשון" נכנס (15.10.2026) — נחשבים כאילו התחילו
  if (!p.startedAt && p.updatedAt && p.updatedAt < "2026-10-15T03:00:00Z") p.startedAt = p.updatedAt;
  return p;
}

export async function setProgress(id: string, p: Partial<Progress>) {
  const cur = await getProgress(id);
  const next: Progress = { ...cur, ...p, updatedAt: new Date().toISOString() };
  await store.writeJSON(P.progress(id), next);
  return next;
}
