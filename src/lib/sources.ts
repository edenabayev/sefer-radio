// מקורות ספרים מעבר לגוטנברג: ארכיון האינטרנט (רק פריטים פתוחים וחוקיים), Open Library למידע על הספר,
// והוספה מקישור. ספר מוגן בזכויות נכנס רק מקובץ/קישור של המשתמש — והחיפוש אומר את זה במפורש.
import crypto from "crypto";
import * as store from "./storage";
import { searchGutenberg, createFromUpload, getBook, type Book } from "./books";
import { GUT_UA } from "./catalog";

export interface Hit {
  source: "gutenberg" | "archive";
  id: string; // gid או identifier
  title: string;
  author?: string;
  year?: number;
  lang?: string;
  note?: string;
}

export interface BookRecord {
  title: string;
  author?: string;
  year?: number;
  coverUrl?: string;
  access: "public" | "borrowable" | "printdisabled" | "no_ebook" | "unknown";
}

export interface SearchResult {
  available: Hit[];
  record?: BookRecord; // "מצאנו את הספר, אבל צריך את הקובץ שלך"
}

const UA = { "User-Agent": GUT_UA };
const MAX_DOWNLOAD = 150 * 1024 * 1024;

export async function searchAll(q: string): Promise<SearchResult> {
  const [gut, ia, rec] = await Promise.all([
    searchGutenberg(q).catch(() => []),
    searchArchive(q).catch(() => [] as Hit[]),
    openLibraryLookup(q).catch(() => undefined),
  ]);
  const available: Hit[] = [
    ...gut.map((g) => ({ source: "gutenberg" as const, id: String(g.gid), title: g.title, author: g.author, lang: g.languages[0] })),
    ...ia,
  ];
  // אם מה שנמצא לא דומה לשאילתה (למשל סארטר), מציגים את הרשומה מ-Open Library עם הסבר
  const record = rec && !available.some((h) => similar(h.title, rec.title)) ? rec : undefined;
  return { available: available.slice(0, 20), record };
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9֐-׿ ]+/g, " ").replace(/\s+/g, " ").trim();
}
function similar(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** ארכיון האינטרנט: רק טקסטים פתוחים (לא "השאלה"), ולא העלאות של משתמשים לספרים חדשים. */
export async function searchArchive(q: string): Promise<Hit[]> {
  const query = `title:(${q.replace(/[()":]/g, " ")}) AND mediatype:texts AND NOT access-restricted-item:true`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=language&fl[]=collection&fl[]=format&rows=20&sort[]=downloads+desc&output=json`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { response?: { docs?: Array<Record<string, unknown>> } };
  const docs = j.response?.docs ?? [];
  const hits: Hit[] = [];
  for (const d of docs) {
    const formats = ([] as string[]).concat((d.format as string[] | string) ?? []);
    const collections = ([] as string[]).concat((d.collection as string[] | string) ?? []);
    const year = Number(d.year) || undefined;
    const hasText = formats.some((f) => /DjVuTXT|Text PDF|^Text$/i.test(f));
    if (!hasText) continue;
    // רק מה שבטוח נחלת הכלל: פורסם לפני 1930, או אוסף גוטנברג. כל השאר (גם העלאות של משתמשים) — לא.
    const publicDomain = (year && year < 1930) || collections.some((c) => /^gutenberg$/i.test(c));
    if (!publicDomain) continue;
    const creator = ([] as string[]).concat((d.creator as string[] | string) ?? [])[0];
    const lang = ([] as string[]).concat((d.language as string[] | string) ?? [])[0];
    hits.push({ source: "archive", id: String(d.identifier), title: String(d.title ?? d.identifier), author: creator, year, lang: lang?.toLowerCase().slice(0, 3), note: "ארכיון האינטרנט" });
    if (hits.length >= 8) break;
  }
  return hits;
}

/** Open Library: שם, מחבר, שנה, עטיפה ומצב גישה — כדי להגיד למשתמש מה מצאנו גם כשאין טקסט חופשי. */
export async function openLibraryLookup(q: string): Promise<BookRecord | undefined> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=3&fields=key,title,author_name,first_publish_year,cover_i,ebook_access`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return undefined;
  const j = (await r.json()) as { docs?: Array<{ title: string; author_name?: string[]; first_publish_year?: number; cover_i?: number; ebook_access?: string }> };
  const d = j.docs?.[0];
  if (!d) return undefined;
  const access = (["public", "borrowable", "printdisabled", "no_ebook"] as const).find((a) => a === d.ebook_access) ?? "unknown";
  return { title: d.title, author: d.author_name?.[0], year: d.first_publish_year, coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined, access };
}

interface IaFile {
  name: string;
  format?: string;
  size?: string;
}

/** ספר מארכיון האינטרנט: טקסט (DjVuTXT) אם יש, אחרת PDF. */
export async function createFromArchive(identifier: string): Promise<Book> {
  const id = "a" + crypto.createHash("sha1").update(identifier).digest("hex").slice(0, 10);
  const existing = await getBook(id);
  if (existing) return existing;
  const meta = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!meta.ok) throw new Error("archive.org " + meta.status);
  const j = (await meta.json()) as { files?: IaFile[]; metadata?: { title?: string; creator?: string | string[]; "access-restricted-item"?: string } };
  if (j.metadata?.["access-restricted-item"] === "true") throw new Error("הפריט הזה ניתן רק להשאלה בארכיון ולא להורדה");
  const files = j.files ?? [];
  const txt = files.find((f) => /_djvu\.txt$/i.test(f.name));
  const pdf = files.find((f) => /\.pdf$/i.test(f.name) && !/_text\.pdf$/i.test(f.name)) || files.find((f) => /\.pdf$/i.test(f.name));
  const pick = txt || pdf;
  if (!pick) throw new Error("לפריט הזה אין קובץ טקסט או PDF להורדה");
  if (pick.size && Number(pick.size) > MAX_DOWNLOAD) throw new Error("הקובץ גדול מדי (מעל 150MB)");
  const fileUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(pick.name)}`;
  const r = await fetch(fileUrl, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error("הורדה מהארכיון נכשלה: " + r.status);
  const data = Buffer.from(await r.arrayBuffer());
  const ext = txt ? "txt" : "pdf";
  const pathname = `uploads/archive-${identifier}.${ext}`;
  const url = await store.writeBytes(pathname, data, ext === "pdf" ? "application/pdf" : "text/plain; charset=utf-8");
  const creator = ([] as string[]).concat(j.metadata?.creator ?? [])[0];
  return createFromUpload(url, `${identifier}.${ext}`, pathname, { id, title: j.metadata?.title || identifier, author: creator });
}

/** הוספה מקישור: השרת מוריד את הקובץ (PDF/EPUB/טקסט) ושומר אותו — ואז אותו מסלול כמו העלאה. */
export async function createFromUrl(rawUrl: string): Promise<Book> {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("קישור לא תקין");
  const r = await fetch(url, { headers: { ...UA, Accept: "application/pdf,application/epub+zip,text/plain,*/*" }, redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error("הורדה נכשלה: " + r.status);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > MAX_DOWNLOAD) throw new Error("הקובץ גדול מדי (מעל 150MB)");
  const nameFromUrl = decodeURIComponent(url.pathname.split("/").pop() || "book");
  let ext = (nameFromUrl.split(".").pop() || "").toLowerCase();
  if (!["pdf", "epub", "txt", "md"].includes(ext)) {
    if (ct.includes("pdf") || data.subarray(0, 4).toString() === "%PDF") ext = "pdf";
    else if (ct.includes("epub") || (data[0] === 0x50 && data[1] === 0x4b)) ext = "epub";
    else if (ct.includes("text/plain")) ext = "txt";
    else if (ct.includes("text/html")) throw new Error("זה דף אינטרנט, לא קובץ ספר. צריך קישור ישיר ל-PDF/EPUB/טקסט");
    else throw new Error("לא זיהיתי את סוג הקובץ (" + ct + ")");
  }
  const hash = crypto.createHash("sha1").update(rawUrl).digest("hex").slice(0, 10);
  const filename = (nameFromUrl.replace(/\.[^.]+$/, "") || "book") + "." + ext;
  const pathname = `uploads/url-${hash}.${ext}`;
  const stored = await store.writeBytes(pathname, data, ext === "pdf" ? "application/pdf" : ext === "epub" ? "application/epub+zip" : "text/plain; charset=utf-8");
  return createFromUpload(stored, filename, pathname, { id: "l" + hash });
}
