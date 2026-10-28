// הספר כעץ: ספר → פרקים → קטעים עם מזהה קבוע. כל תוצר (תרגום, שמע, הסבר) נשמר לפי הקטע
// ונבדק לפני שמייצרים — "הזיכרון" של האפליקציה.
import crypto from "crypto";
import * as store from "./storage";
import { fetchWithMirrors, loadCatalog, searchCatalog, GUT_UA } from "./catalog";
import { genText, tts, extractPdfPages, pdfPageCount, PDF_CHUNK_PAGES, VOICE, SAMPLE_RATE, askWithAudio, TTS_VERSION } from "./gemini";
import { KOKORO_VERSION, KOKORO_DEFAULT, kokoroVoice } from "./kokoro-voices";
import { NIQQUD_VERSION, NIQQUD_TAG } from "./niqqud-version";
import { pcm16ToMp3 } from "./mp3";
import { buildSections, cleanSectionText, cleanSourceText, cleanSourceParagraphs, detectLang, epubToParagraphs, markdownToParagraphs, stripGutenberg, toParagraphs, type Chapter, type Section, type Lang } from "./text";

export interface Extraction {
  status: "pending" | "done" | "error";
  totalPages: number;
  nextPage: number; // העמוד הבא לחילוץ (1-based)
  markdown: string; // ישן: הטקסט שחולץ נשמר בתוך book.json. חדש: ריק, והטקסט בקובץ extracted.md
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
  /** דור התרגום (לא נשמר ב-book.json — נקרא מקבצי סימון). "תרגם מחדש לפי הכרטיס" פותח דור חדש:
   *  תרגומים ושמע עברי בנתיבים חדשים, והישנים נשארים בצד. בלי דור — הנתיבים המקוריים. */
  trGen?: string;
  /** הקלטה מחדש עם ניקוד (לא נשמר ב-book.json — נקרא מקבצי סימון): כל קטע (from) מתחיל תיקייה משלו (tag),
   *  עד הקטע הבא. "n" = ניקוד חלקי (28.10 בבוקר, תיקיית v3n), "n2" = ניקוד מלא (28.10 בערב, v3n2).
   *  כך לא דורסים שמע שאולי מתנגן עכשיו. בלי סימון — הכול בתיקייה הרגילה. */
  nqSegs?: NqSeg[];
  /** קטעים שהוקלטו מחדש בודדים (קטע → זמן ההקלטה), מקבצי סימון — למשל קטע שגוגל סירב לתרגם ותורגם אחר כך בגיבוי.
   *  כל הקלטה בשם חדש, כך שזרם שכבר מתנגן ממשיך עם הקבצים הישנים. */
  fixes?: Record<number, number>;
}

export interface NqSeg {
  from: number;
  tag: string;
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

/** סיומת הדור לנתיבים של תרגום ושמע עברי (רק בספר שאינו בעברית, ורק אחרי "תרגם מחדש"). */
export const trSuffix = (book: Pick<Book, "lang" | "trGen">) => (book.trGen && book.lang !== "he" ? `-t${book.trGen}` : "");
/** תיקיית התרגומים לעברית של הדור הנוכחי. */
export const heDir = (book: Pick<Book, "id" | "lang" | "trGen">) => `books/${book.id}/he${book.trGen && book.lang !== "he" ? "-" + book.trGen : ""}/`;
export const heTextPath = (book: Pick<Book, "id" | "lang" | "trGen">, i: number) => `${heDir(book)}${i}.txt`;
export const heMapPath = (book: Pick<Book, "id" | "lang" | "trGen">) => `books/${book.id}/he${book.trGen && book.lang !== "he" ? "-" + book.trGen : ""}.json`;
/** תיקיית השמע העברי. tag = הקלטה מחדש עם ניקוד ("n", "n2"…), לפי הקטע (nqTagFor). */
export const heAudioDir = (book: Pick<Book, "id" | "lang" | "trGen">, voice: string, tag?: string) => `books/${book.id}/audio/he/${voice}-${TTS_VERSION}${tag ?? ""}${trSuffix(book)}/`;
/** לאיזו הקלטה מחדש שייך הקטע: הסימון עם ה-from הגדול ביותר שלא אחרי הקטע. */
export function nqTagFor(book: Pick<Book, "nqSegs">, i: number): string | undefined {
  let tag: string | undefined;
  for (const s of book.nqSegs ?? []) if (s.from <= i) tag = s.tag;
  return tag;
}
/** הקלטה מחדש של קטע בודד: קובץ בשם ייחודי בתיקייה נפרדת. */
export const heFixDir = (book: Pick<Book, "id" | "lang" | "trGen">, voice: string) => `books/${book.id}/audio/he/${voice}-${TTS_VERSION}f${trSuffix(book)}/`;
/** הטקסט המנוקד שהולך לקול (לפי דור התרגום). מחוץ לתיקיית התרגומים — כדי שלא ייספר כתרגום. */
export const niqqudPath = (book: Pick<Book, "id" | "lang" | "trGen">, i: number) => `books/${book.id}/nq${NIQQUD_VERSION > 1 ? NIQQUD_VERSION : ""}${trSuffix(book)}/${i}.txt`;

const P = {
  book: (id: string) => `books/${id}/book.json`,
  trGen: (id: string) => `books/${id}/trgen/`,
  audio: (book: Book, i: number, lang: string, voice: string) =>
    lang === "en"
      ? `books/${book.id}/audio/en/${voice}-${KOKORO_VERSION}/${i}.mp3`
      : book.fixes?.[i]
        ? `${heFixDir(book, voice)}${i}-${book.fixes[i]}.mp3`
        : `${heAudioDir(book, voice, nqTagFor(book, i))}${i}.mp3`,
  explain: (id: string, i: number) => `books/${id}/explain/${i}.txt`,
  explainAudio: (id: string, i: number, voice: string) => `books/${id}/explain/${voice}-${TTS_VERSION}/${i}.mp3`,
  progress: (id: string) => `books/${id}/progress.json`,
  refused: (id: string, i: number) => `books/${id}/refused/${i}.json`, // גוגל סירב לתרגם את הקטע — לא מנסים שוב כל דקה
  trFallback: (id: string, i: number) => `books/${id}/tr-fallback/${i}.json`, // הקטע תורגם ב-Google Translate (גיבוי)
  extracted: (id: string) => `books/${id}/extracted.md`, // ישן: קובץ אחד שגדל (נקרא-ונכתב — רגיש לגרסה ישנה מה-Blob)
  extractDir: (id: string) => `books/${id}/extract/`, // חדש: קובץ לכל צעד, בשם קבוע לפי העמודים — אף פעם לא נדרס בתוכן אחר
  extractChunk: (id: string, from: number, to: number) => `books/${id}/extract/${String(from).padStart(5, "0")}-${String(to).padStart(5, "0")}.md`,
  extractLock: (id: string) => `books/${id}/extract.lock.json`,
  answer: (id: string, i: number, hash: string) => `books/${id}/answers/${i}/${hash}.mp3`,
};

/** כותרת פרק כמו שמקריאים אותה: "CHAPTER IV" → "Chapter 4" (המספר הופך למילים בצינור ההקראה). */
export function spokenHeading(title: string, lang: "he" | "en"): string {
  const t = title.replace(/^#\s*/, "").trim();
  // כותרת שהיא רק מספר ("17", "IV") — אומרים "פרק 17" / "Chapter 17"
  if (/^\d{1,3}\.?$/.test(t)) return (lang === "en" ? "Chapter " : "פרק ") + t.replace(/\.$/, "");
  if (lang !== "en") return t;
  const roman = (r: string) => {
    const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let n = 0;
    for (let k = 0; k < r.length; k++) {
      const a = v[r[k]];
      const b = v[r[k + 1]] ?? 0;
      n += a < b ? -a : a;
    }
    return n;
  };
  const m = t.match(/^(chapter|book|part|section|letter)\s+([IVXLCDM]+)\b(.*)$/i);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + " " + roman(m[2].toUpperCase()) + m[3];
  // כותרת כולה באותיות גדולות → אותיות רגילות (אחרת המנוע מאיית)
  return /^[A-Z0-9 ,.'’:;\-]+$/.test(t) && t.length > 3 ? t.charAt(0) + t.slice(1).toLowerCase() : t;
}

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
  const [b, marks] = await Promise.all([store.readJSON<Book>(P.book(id)), readMarkers(id)]);
  if (b) {
    delete b.trGen;
    delete b.nqSegs;
    delete b.fixes;
    if (b.lang !== "he") b.trGen = marks.trGen;
    if (marks.nqSegs) b.nqSegs = marks.nqSegs;
    if (marks.fixes) b.fixes = marks.fixes;
  }
  return b;
}

export async function saveBook(b: Book) {
  const { trGen: _gen, nqSegs: _nq, fixes: _fx, ...rest } = b;
  void _gen;
  void _nq;
  void _fx;
  await store.writeJSON(P.book(b.id), rest);
}

/** קבצי הסימון של הספר (שמות ייחודיים — רשימת קבצים תמיד טרייה, בלי גרסה ישנה מה-Blob):
 *  `<זמן>.json` = דור תרגום; `nq-<זמן>-<קטע>.json` = ניקוד מהקטע הזה והלאה. האחרון קובע. */
async function readMarkers(id: string): Promise<{ trGen?: string; nqSegs?: NqSeg[]; fixes?: Record<number, number> }> {
  const dir = P.trGen(id);
  const names = (await store.listPaths(dir)).map((p) => p.slice(dir.length));
  const gens = names.map((n) => n.match(/^(\d+)\.json$/)?.[1]).filter((x): x is string => !!x);
  // nq-<זמן>-<קטע>.json = ניקוד חלקי מהקטע הזה ("n"); nq-<זמן>-<קטע>-<תג>.json = הקלטה מחדש אחרת (למשל "n2" = ניקוד מלא)
  const byFrom = new Map<number, { ts: number; tag: string }>();
  for (const n of names) {
    const m = n.match(/^nq-(\d+)-(\d+)(?:-([a-z0-9]+))?\.json$/);
    if (!m) continue;
    const ts = Number(m[1]);
    const from = Number(m[2]);
    const prev = byFrom.get(from);
    if (!prev || ts > prev.ts) byFrom.set(from, { ts, tag: m[3] || "n" });
  }
  const nqSegs = [...byFrom.entries()].sort((a, b) => a[0] - b[0]).map(([from, v]) => ({ from, tag: v.tag }));
  // fx-<זמן>-<קטע>.json = הקטע הוקלט מחדש (האחרון לכל קטע קובע)
  let fixes: Record<number, number> | undefined;
  for (const n of names) {
    const m = n.match(/^fx-(\d+)-(\d+)\.json$/);
    if (!m) continue;
    fixes ??= {};
    const ts = Number(m[1]);
    const i = Number(m[2]);
    if (!fixes[i] || ts > fixes[i]) fixes[i] = ts;
  }
  return { trGen: gens.sort((a, b) => Number(b) - Number(a))[0], nqSegs: nqSegs.length ? nqSegs : undefined, fixes };
}

/** הדור הנוכחי של התרגום. */
export async function readTrGen(id: string): Promise<string | undefined> {
  return (await readMarkers(id)).trGen;
}

/** ניקוד מהקטע הזה והלאה: השמע העברי שלהם יוקלט מחדש (בתיקייה נפרדת), הקודמים נשארים כמו שהם. */
export async function setNqFrom(id: string, from: number, tag = NIQQUD_TAG, now = Date.now()): Promise<number> {
  const name = tag === "n" ? `nq-${now}-${from}.json` : `nq-${now}-${from}-${tag}.json`;
  await store.writeJSON(`${P.trGen(id)}${name}`, { at: new Date(now).toISOString(), from, tag });
  return from;
}

/** "תרגם מחדש לפי הכרטיס": דור חדש — מהרגע הזה תרגומים ושמע עברי נוצרים מחדש (רק כשמאזינים להם). */
export async function newTrGen(id: string, cardId?: string, now = Date.now()): Promise<string> {
  const gen = String(now);
  await store.writeJSON(`${P.trGen(id)}${gen}.json`, { at: new Date(now).toISOString(), card: cardId });
  return gen;
}

/** כמה קטעים כבר תורגמו בדור הנוכחי, וכמה מהם לפני תאריך מסוים (למשל לפני הכרטיס האחרון). */
export async function translationStats(book: Book, before?: string): Promise<{ translated: number; older: number }> {
  if (book.lang === "he") return { translated: 0, older: 0 };
  const files = (await store.listFiles(heDir(book))).filter((f) => /\/\d+\.txt$/.test(f.path));
  const t = before ? new Date(before).getTime() : 0;
  return { translated: files.length, older: before ? files.filter((f) => f.uploadedAt != null && f.uploadedAt < t).length : files.length };
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
/** הטקסט שחולץ מה-PDF עד כה (בקובץ נפרד; ספרים ישנים — בתוך book.json). */
interface Chunk {
  from: number;
  to: number;
  path: string;
}

/** הצעדים שכבר נקראו, לפי הסדר ובלי חפיפות (רשימת קבצים — תמיד טרייה, גם כשקובץ שנכתב עכשיו עוד לא "נראה" בקריאה). */
async function readChunks(id: string): Promise<{ chunks: Chunk[]; next: number }> {
  const dir = P.extractDir(id);
  const all = (await store.listPaths(dir))
    .map((p) => {
      const m = p.slice(dir.length).match(/^(\d+)-(\d+)\.md$/);
      return m ? { from: Number(m[1]), to: Number(m[2]), path: p } : null;
    })
    .filter((c): c is Chunk => !!c)
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const chunks: Chunk[] = [];
  let next = 1;
  for (const c of all) {
    if (c.from !== next) continue; // חפיפה (אותו צעד פעמיים) או חור
    chunks.push(c);
    next = c.to + 1;
  }
  return { chunks, next };
}

/** הטקסט שחולץ מה-PDF עד כה: מקבצי הצעדים; ספרים ישנים — מהקובץ האחד (או מתוך book.json). */
async function extractedMarkdown(book: Book): Promise<string> {
  const { chunks } = await readChunks(book.id);
  if (chunks.length) return (await Promise.all(chunks.map((c) => store.readText(c.path)))).map((t) => (t ?? "").trim()).filter(Boolean).join("\n\n");
  if (book.extraction?.markdown) return book.extraction.markdown;
  return (await store.readText(P.extracted(book.id))) ?? "";
}

export async function rebuildBook(id: string): Promise<Book> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  if (book.source.type !== "upload") return book;
  if (book.source.kind === "pdf") {
    // בנייה מחדש מהטקסט שכבר חולץ (בלי לקרוא את ה-PDF שוב) — למשל אחרי שיפור בזיהוי כותרות
    const md = await extractedMarkdown(book);
    if (!md) return book;
    const b = buildSections(markdownToParagraphs(md), book.title);
    book.chapters = b.chapters;
    book.sections = b.sections;
    await saveBook(book);
    return book;
  }
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

/** צעד חילוץ אחד (עד PDF_CHUNK_PAGES עמודים). רץ מהלקוח כשהספר פתוח וגם מה-cron ברקע; נעילה מונעת כפילות. */
class DoneAlready extends Error {}

/** קריאת PDF בצעדים. קודם מנסים לקרוא את שכבת הטקסט כאן על השרת (מהיר, חינם, 100 עמודים לצעד, ובלי סירוב של גוגל
 *  לטקסט מוגן); רק PDF סרוק (בלי טקסט) או בעברית עובר לגוגל, 25 עמודים לצעד. retry — ניסיון מחדש אחרי שגיאה. */
const localChunkPages = () => Number(process.env.LOCAL_PDF_CHUNK) || 100; // בבדיקות אפשר צעדים קטנים
export async function extractStep(id: string, opts: { retry?: boolean; restart?: boolean } = {}): Promise<{ book: Book; busy: boolean }> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  const ex = book.extraction;
  if (ex && opts.restart) {
    // קריאה מחדש מהעמוד הראשון (למשל אחרי תיקון בקורא): מוחקים את מה שחולץ — זה תוצר שלנו, לא הקובץ של המשתמש
    await Promise.all([...(await store.listPaths(P.extractDir(id))), P.extracted(id)].map((p) => store.remove(p)));
    Object.assign(ex, { status: "pending", nextPage: 1, markdown: "", error: undefined });
    book.sections = [];
    book.chapters = [];
    await saveBook(book);
  }
  if (ex && ex.status === "error" && (opts.retry || opts.restart)) {
    ex.status = "pending";
    ex.error = undefined;
  }
  if (!ex || ex.status !== "pending") return { book, busy: false };
  if (book.source.type === "gutenberg" || !book.source.url) return { book, busy: false };
  const lock = await store.readJSON<{ until: string }>(P.extractLock(id));
  if (lock && new Date(lock.until).getTime() > Date.now()) return { book, busy: true };
  await store.writeJSON(P.extractLock(id), { until: new Date(Date.now() + 150_000).toISOString() });
  try {
    // מאיפה ממשיכים: לפי קבצי הצעדים (טרי), ולא לפי book.json (שאחרי כתיבה יכול להיקרא בגרסה ישנה — וכך צעד רץ פעמיים)
    const done = await readChunks(id);
    const legacy = !done.chunks.length && ex.nextPage > 1; // ספר שהתחיל להיקרא בשיטה הישנה (קובץ אחד)
    const from = legacy ? ex.nextPage : done.next;
    let to = Math.min(ex.totalPages, from + PDF_CHUNK_PAGES - 1);
    let markdown = legacy ? await extractedMarkdown(book) : "";
    try {
      if (from > ex.totalPages) throw new DoneAlready();
      const pdf = await readSource(book.source.url, book.source.pathname);
      const { extractPdfText, repairLigatures, fixDropCaps, isHebrewText } = await import("./pdftext");
      const localTo = Math.min(ex.totalPages, from + localChunkPages() - 1);
      const local = await extractPdfText(pdf, from, localTo).catch((e) => {
        console.warn("local pdf text", id, (e as Error).message);
        return null;
      });
      const textLayer = !!local && local.pages > 0 && local.chars >= local.pages * 150; // עמוד טקסט רגיל: 1,000+ תווים
      let md: string;
      if (local && textLayer && !isHebrewText(local.markdown)) {
        md = await fixDropCaps(repairLigatures(local.markdown));
        to = localTo;
      } else {
        try {
          md = await extractPdfPages(pdf, from, to); // סרוק או עברית — גוגל קורא את העמודים
        } catch (e) {
          if (!local || !textLayer) throw e; // גוגל סירב ואין שכבת טקסט — אין מה לעשות
          md = repairLigatures(local.markdown);
          to = localTo;
        }
      }
      if (legacy) {
        markdown = (markdown ? markdown + "\n\n" : "") + md;
        if (markdown) await store.writeBytes(P.extracted(id), markdown, "text/markdown; charset=utf-8");
      } else {
        // קובץ לצעד הזה בלבד; אם שני תהליכים קראו את אותו צעד — אותו שם ואותו תוכן, בלי כפילות
        await store.writeBytes(P.extractChunk(id, from, to), md || " ", "text/markdown; charset=utf-8");
        const chunks = [...done.chunks.map((c) => c.path), P.extractChunk(id, from, to)];
        const texts = await Promise.all(chunks.slice(0, -1).map((p) => store.readText(p)));
        markdown = [...texts.map((t) => (t ?? "").trim()), md.trim()].filter(Boolean).join("\n\n");
      }
      ex.nextPage = to + 1;
      if (ex.nextPage > ex.totalPages) ex.status = "done";
      ex.error = undefined;
    } catch (e) {
      if (e instanceof DoneAlready) {
        ex.nextPage = from;
        ex.status = "done";
        markdown = await extractedMarkdown(book);
      } else {
        ex.status = "error";
        ex.error = String((e as Error)?.message || e);
        if (!legacy) markdown = await extractedMarkdown(book);
      }
    }
    ex.markdown = "";
    // בונים מחדש את הקטעים מכל מה שחולץ עד כה — כך אפשר להתחיל להאזין לפני שהספר כולו נקרא
    const built = buildSections(markdownToParagraphs(markdown), book.title);
    book.chapters = built.chapters;
    book.sections = built.sections;
    if (book.lang === "other" && markdown.length > 500) book.lang = detectLang(markdown);
    await saveBook(book);
    return { book, busy: false };
  } finally {
    await store.remove(P.extractLock(id));
  }
}

// ---------- תרגום ----------

/** תרגום קטע לעברית — לפי כרטיס התרגום של הספר (אם אין — חוקרים קודם; אם המחקר לא אפשרי עכשיו — בלי כרטיס).
 *  נשמר פעם אחת לכל דור. עם save:false — דוגמה שלא נשמרת (לבדיקת הכרטיס). */
/** גוגל מסרב לתרגם את הקטע (תוכן חסום / תשובה ריקה). נרשם, ולא מנסים שוב לפני שעבר יום. */
export class TranslationRefused extends Error {}
const REFUSAL_RETRY_MS = 24 * 3600 * 1000;
const isRefusal = (msg: string) => /PROHIBITED_CONTENT|SAFETY|BLOCKLIST|RECITATION|SPII|תשובה ריקה/i.test(msg);

// תרגום שכבר רץ באותו תהליך (למשל הכנה מראש של הקטע הבא) — מחכים לו במקום לתרגם פעמיים.
// נרשם מיד בקריאה (לפני בדיקת הקובץ), כדי ששתי קריאות צמודות לא יתרגמו שתיהן.
const trInFlight = new Map<string, Promise<string>>();

export async function ensureTranslation(book: Book, i: number, opts: { save?: boolean; model?: string } = {}): Promise<string> {
  const sec = book.sections[i];
  if (!sec) throw new Error("אין קטע " + i);
  if (book.lang === "he") return sec.text;
  const save = opts.save !== false;
  const key = heTextPath(book, i);
  const translate = async () => {
    const { ensureCard, translationPrompt } = await import("./translation");
    const card = await ensureCard(book, { wait: true }).catch(() => null);
    const prevHe = i > 0 ? await store.readText(heTextPath(book, i - 1)) : null;
    const { system, prompt } = translationPrompt(book, i, card, prevHe);
    return cleanTranslation(await genText(prompt, system, 8192, { thinking: "MEDIUM", model: opts.model }));
  };
  if (!save) return translate();
  const running = trInFlight.get(key);
  if (running) return running;
  // גוגל (Gemini) סירב: לא מתווכחים — עוברים מיד ל-Google Translate. אם גם הוא נכשל — הקטע יוקרא במקור.
  const fallback = async (reason: string): Promise<string> => {
    try {
      const paras = cleanSectionText(book, i)
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      const he = (await (await import("./gtranslate")).googleTranslate(paras, "he", book.lang === "en" ? "en" : undefined)).join("\n\n");
      if (!/[\u05D0-\u05EA]/.test(he)) throw new Error("התרגום לא בעברית");
      await store.writeBytes(key, he, "text/plain; charset=utf-8");
      await store.writeJSON(P.trFallback(book.id, i), { at: new Date().toISOString(), engine: "google-translate", reason }).catch(() => {});
      console.log(`translation fallback ${book.id}#${i}: Google Translate`);
      return he;
    } catch (e2) {
      console.warn(`translation fallback ${book.id}#${i} failed:`, (e2 as Error).message);
      throw new TranslationRefused(reason);
    }
  };
  const run = (async () => {
    const cached = await store.readText(key);
    if (cached) return cached;
    const refused = await store.readJSON<{ at: string; reason: string }>(P.refused(book.id, i));
    if (refused && Date.now() - new Date(refused.at).getTime() < REFUSAL_RETRY_MS) return fallback(refused.reason);
    let he: string;
    try {
      he = await translate();
    } catch (e) {
      const msg = (e as Error).message || "";
      if (!isRefusal(msg)) throw e;
      await store.writeJSON(P.refused(book.id, i), { at: new Date().toISOString(), reason: msg }).catch(() => {});
      return fallback(msg);
    }
    await store.writeBytes(key, he, "text/plain; charset=utf-8");
    return he;
  })();
  trInFlight.set(key, run);
  run.finally(() => trInFlight.delete(key)).catch(() => {});
  return run;
}

/** הכנה מראש של הטקסט לקול (תרגום + ניקוד) לקטע הבא — בזמן שהקול של הקטע הנוכחי נוצר.
 *  קודם מחכים לתרגום של הקטע שלפניו (אם הוא בדרך) — המתרגם משתמש בסופו כהקשר. */
export function prefetchSpokenText(book: Book, i: number): Promise<void> {
  if (!book.sections[i]) return Promise.resolve();
  return (async () => {
    if (i > 0) await ensureTranslation(book, i - 1).catch(() => null);
    const text = await ensureTranslation(book, i);
    await (await import("./niqqud")).withNiqqud(niqqudPath(book, i), text, `${book.id}#${i}`);
  })().catch((e) => console.warn("prefetch", book.id, i, (e as Error).message));
}

/** קטע שגוגל סירב לתרגם: משפט קצר בעברית, ואז הקטע במקור באנגלית (Kokoro) — כדי שההאזנה לא תיעצר ולא ידלג תוכן. */
async function refusedSectionPcm(englishText: string, heVoice: string, why: "translate" | "read" = "translate"): Promise<Buffer> {
  const note = await tts(why === "translate" ? "את הקטע הבא גוגל סירב לתרגם, אז הוא מוקרא במקור, באנגלית." : "את הקטע הבא גוגל סירב להקריא בעברית, אז הוא מוקרא במקור, באנגלית.", "he", heVoice);
  const { pcm } = await (await import("./kokoro")).kokoroTts(englishText, KOKORO_DEFAULT);
  const gap = Buffer.alloc(Math.round(SAMPLE_RATE * 0.8) * 2);
  return Buffer.concat([note, gap, pcm, gap]);
}

/** הקלטה מחדש של קטע בודד (למשל אחרי שתורגם בגיבוי): קובץ חדש בשם ייחודי, ורק אחריו סימון —
 *  זרם שכבר מתנגן לא משתנה, וזרם חדש מקבל את ההקלטה החדשה. */
export async function rerecordSection(book: Book, i: number, voice = VOICE): Promise<{ section: number; url: string; seconds: number; hebrew: boolean }> {
  if (!book.sections[i]) throw new Error("אין קטע " + i);
  const he = await ensureTranslation(book, i); // אם התרגום נכשל לגמרי — זורק, ולא מקליטים שוב סתם
  const ts = Date.now();
  const copy: Book = { ...book, fixes: { ...(book.fixes ?? {}), [i]: ts } };
  const r = await ensureAudio(copy, i, "he", voice);
  await store.writeJSON(`${P.trGen(book.id)}fx-${ts}-${i}.json`, { at: new Date(ts).toISOString(), section: i, voice });
  const size = (await store.listFiles(heFixDir(book, voice))).find((f) => f.path.endsWith(`/${i}-${ts}.mp3`))?.size ?? 0;
  return { section: i, url: r.url, seconds: Math.round(size / 6000), hebrew: /[\u05D0-\u05EA]/.test(he) };
}

/** מה שהמודל מוסיף לפעמים מסביב לתרגום: "הנה התרגום:", מרכאות קוד, תגיות ההקשר. */
export function cleanTranslation(t: string): string {
  return t
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .replace(/^\s*\((?:הקטע לתרגום|תרגום)[^)]*\):?\s*/u, "")
    .replace(/^\s*(?:הנה התרגום|התרגום)\s*:\s*\n/u, "")
    .trim();
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
  // במקור: בלי כותרות רצות ובלי שבירת פסקה באמצע משפט (רק לשמע חדש; קבצים קיימים לא משתנים)
  let text: string;
  let refusedEn = false; // גוגל סירב לתרגם — מקריאים את הקטע במקור (אנגלית), אחרי משפט הסבר קצר בעברית
  if (lang === "he") {
    try {
      text = await ensureTranslation(book, i);
    } catch (e) {
      if (!(e instanceof TranslationRefused) || book.lang !== "en") throw e;
      refusedEn = true;
      text = cleanSectionText(book, i);
    }
  } else text = effLang === "en" ? cleanSectionText(book, i) : sec.text;
  if (effLang === "en") voice = kokoroVoice(voice);
  const p = P.audio(book, i, effLang, voice);
  const url = await store.exists(p);
  if (url) return { url, text, lang: effLang, cached: true };
  // כותרת הפרק נקראת לפני הקטע הראשון שלו — רק כשהכותרת באותה שפה כמו ההקראה
  const ch = book.chapters[sec.chapter];
  const sameLang = effLang === "he" ? book.lang === "he" : book.lang !== "he";
  const heading = ch && ch.start === i && sameLang && ch.title && !/^(התחלה|START)$/i.test(ch.title) ? spokenHeading(ch.title, effLang) : "";
  // עברית: ניקוד רק במילים שהקול עלול לקרוא לא נכון (שׂ, דגש, מילים דו-משמעיות). על המסך — הטקסט הרגיל.
  const body = effLang === "he" ? await (await import("./niqqud")).withNiqqud(niqqudPath(book, i), text, `${book.id}#${i}`) : text;
  const spoken = heading ? heading + "\n\n" + body : body;
  // אנגלית: Kokoro (קוד פתוח, רץ כאן על המעבד, בלי עלות לפי תו). עברית: Gemini.
  const pcm = refusedEn
    ? await refusedSectionPcm(text, voice)
    : effLang === "en"
      ? (await (await import("./kokoro")).kokoroTts(spoken, voice, { headingFirst: !!heading })).pcm
      : await tts(spoken, effLang, voice, { headingFirst: !!heading }).catch(async (e) => {
          // הקול של גוגל סירב להקריא את העברית — בספר באנגלית: במקור, אחרי משפט הסבר (לא נתקעים)
          if (book.lang !== "en" || !/מסרב|PROHIBITED|SAFETY|BLOCK|OTHER|לא החזיר שמע/i.test(String((e as Error)?.message))) throw e;
          console.warn(`tts refused ${book.id}#${i}, reading the original:`, (e as Error).message);
          return refusedSectionPcm(cleanSectionText(book, i), voice, "read");
        });
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
  const he = book.lang === "he" ? sec.text : (await store.readText(heTextPath(book, i))) ?? sec.text;
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
