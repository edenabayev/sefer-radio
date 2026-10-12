// קטלוג גוטנברג מקומי: מורידים פעם אחת את קובץ הקטלוג הרשמי (CSV), שומרים גרסה מצומצמת,
// ומחפשים בו — כך החיפוש לא תלוי בשרת החיפוש של גוטנברג, שנופל לעיתים קרובות.
import * as store from "./storage";

export interface CatalogEntry {
  gid: number;
  title: string;
  author: string;
  lang: string;
}

const CATALOG_PATH = "catalog/gutenberg.json";
const CSV_URLS = [
  "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv",
  "https://gutenberg.pglaf.org/cache/epub/feeds/pg_catalog.csv",
  "https://aleph.gutenberg.org/cache/epub/feeds/pg_catalog.csv",
];
export const GUT_UA = "sefer-radio (personal study app; contact: edenabayev@gmail.com)";

let memo: { at: number; entries: CatalogEntry[] } | null = null;

/** פענוח CSV לפי התקן (שדות במרכאות יכולים להכיל פסיקים ושורות חדשות). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function fetchWithMirrors(urls: string[], init?: RequestInit, tries = 2): Promise<Response> {
  let last: unknown = null;
  for (let t = 0; t < tries; t++) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { ...init, headers: { "User-Agent": GUT_UA, ...(init?.headers || {}) }, signal: AbortSignal.timeout(60000) });
        if (r.ok) return r;
        last = new Error(`${u} → ${r.status}`);
      } catch (e) {
        last = e;
      }
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function buildCatalog(): Promise<{ count: number }> {
  const r = await fetchWithMirrors(CSV_URLS);
  const csv = await r.text();
  const rows = parseCsv(csv);
  const header = rows[0].map((h) => h.trim());
  const iId = header.indexOf("Text#");
  const iType = header.indexOf("Type");
  const iTitle = header.indexOf("Title");
  const iLang = header.indexOf("Language");
  const iAuth = header.indexOf("Authors");
  const entries: CatalogEntry[] = [];
  for (const row of rows.slice(1)) {
    if (row.length < header.length) continue;
    if (row[iType] !== "Text") continue;
    const lang = row[iLang].trim();
    if (!/^(en|he)\b/.test(lang)) continue; // אנגלית ועברית בלבד — זה מה שהאפליקציה יודעת להקריא
    const gid = Number(row[iId]);
    if (!gid) continue;
    const title = row[iTitle].replace(/\s+/g, " ").trim();
    const author = row[iAuth]
      .split(";")[0]
      .replace(/,\s*-?\d{1,4}\??\s*-.*$/, "") // "Austen, Jane, 1775-1817" → "Austen, Jane"; "Marcus Aurelius, Emperor of Rome, 121-180"
      .trim();
    entries.push({ gid, title, author, lang: lang.slice(0, 2) });
  }
  await store.writeJSON(CATALOG_PATH, entries);
  memo = { at: Date.now(), entries };
  return { count: entries.length };
}

export async function loadCatalog(): Promise<CatalogEntry[] | null> {
  if (memo && Date.now() - memo.at < 10 * 60 * 1000) return memo.entries;
  const entries = await store.readJSON<CatalogEntry[]>(CATALOG_PATH);
  if (entries) memo = { at: Date.now(), entries };
  return entries;
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9֐-׿ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchCatalog(entries: CatalogEntry[], q: string, limit = 15): CatalogEntry[] {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  const scored: { e: CatalogEntry; score: number }[] = [];
  for (const e of entries) {
    const t = norm(e.title);
    const a = norm(e.author);
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (t.includes(w)) score += t.split(" ").includes(w) ? 3 : 2;
      else if (a.includes(w)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // "מדיטציות מרקוס אורליוס": המילים שאינן שם המחבר צריכות להיות הכותרת עצמה
    const titleWords = words.filter((w) => !a.includes(w)).join(" ");
    if (titleWords && t === titleWords) score += 10;
    else if (titleWords && t.startsWith(titleWords)) score += 4;
    if (t === words.join(" ")) score += 10;
    score -= Math.min(3, t.length / 60); // כותרות קצרות = בדרך כלל הספר עצמו ולא "הערות על..."
    scored.push({ e, score });
  }
  scored.sort((x, y) => y.score - x.score || x.e.gid - y.e.gid);
  return scored.slice(0, limit).map((s) => s.e);
}
