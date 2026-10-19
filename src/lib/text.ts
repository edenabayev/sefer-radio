// עבודה על טקסט: זיהוי שפה, חלוקה לפרקים ולקטעים, ניקוי טקסט של גוטנברג, פירוק EPUB.
import JSZip from "jszip";

export type Lang = "he" | "en" | "other";

export function detectLang(sample: string): Lang {
  const s = sample.slice(0, 20000);
  const heb = (s.match(/[֐-׿]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  if (heb > lat * 0.5 && heb > 50) return "he";
  if (lat > 50) return "en";
  return heb > 0 ? "he" : "other";
}

/** מסיר שורות מידע של בן־יהודה ("מעודכן לתאריך", כתובת) וכתובות אינטרנט בודדות מתחילת קובץ טקסט. */
export function cleanSourceText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = lines.slice(0, 25).filter((l) => !/benyehuda\.org|פרויקט בן.יהודה|מעודכן לתאריך|^\s*https?:\/\/\S+\s*$/.test(l));
  return [...head, ...lines.slice(25)].join("\n");
}

const HEADER_RE = /benyehuda\.org|פרויקט בן.יהודה|מעודכן לתאריך|^\s*https?:\/\/\S+\s*$/;

/** אותו ניקוי לפסקאות (EPUB של בן־יהודה מכניס את שורות המידע לעמוד הראשון). */
export function cleanSourceParagraphs(paras: string[]): string[] {
  return paras.filter((p, k) => !(k < 15 && HEADER_RE.test(p)) && !/^\s*https?:\/\/\S+\s*$/.test(p));
}

/** מסיר את הכותרת והסיום של פרויקט גוטנברג. */
export function stripGutenberg(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n");
  const start = t.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (start >= 0) t = t.slice(t.indexOf("\n", start) + 1);
  const end = t.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

/** הופך טקסט עם שבירות שורה קשיחות (כמו בגוטנברג) לפסקאות. */
export function toParagraphs(text: string): string[] {
  const norm = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  return norm
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
}

const HEADING_RE =
  /^(?:(?:CHAPTER|BOOK|PART|LETTER|SECTION|Chapter|Book|Part|Letter|Section)\s+(?:[IVXLCDM]+|\d+|[A-Z][a-z]+)\b.*|[IVXLCDM]{1,7}\.?|\d{1,3}\.?|(?:פרק|חלק|ספר|שער|מאמר|אגרת|מכתב)\s+\S+.*)$/;

/** שורת דובר ("VASISTHA said:", "רמה שאל:") — חילוץ PDF מסמן אותה ככותרת, אבל היא לא פרק. */
const SPEAKER_RE = /:\s*$|\b(said|replied|continued|asked|answered|אמר|אמרה|השיב|השיבה|שאל|שאלה|המשיך|המשיכה)\b\s*:/i;

export function isHeading(p: string): boolean {
  if (p.startsWith("# ")) return !SPEAKER_RE.test(p.trim()); // כותרת מסומנת (מ-EPUB או מחילוץ PDF)
  if (p.length > 90) return false;
  if (HEADING_RE.test(p.trim())) return true;
  // שורה קצרה כולה באותיות גדולות (כותרת באנגלית)
  if (/^[A-Z][A-Z0-9 ,.'’:;\-]{3,60}$/.test(p.trim()) && !/[a-z]/.test(p)) return true;
  return false;
}

export interface Chapter {
  title: string;
  start: number; // אינדקס הקטע הראשון
  end: number; // אינדקס הקטע האחרון (כולל)
}
export interface Section {
  i: number;
  chapter: number;
  text: string;
}

const TARGET = 1400; // תווים לקטע — כ-1.5–2 דקות דיבור
const MAX = 2000;
const MIN_CHAPTER = 1200; // פרק קצר מזה (פחות מקטע אחד) הוא כנראה כותרת-משנה — מצטרף לקודם

/** מחלק רשימת פסקאות (עם כותרות) לפרקים ולקטעים בגודל נוח להאזנה. */
export function buildSections(paragraphs: string[], fallbackTitle = "התחלה"): { chapters: Chapter[]; sections: Section[] } {
  const chapters: Chapter[] = [];
  const sections: Section[] = [];
  let curTitle = fallbackTitle;
  let curParas: string[] = [];
  let chapterIdx = -1;

  const flushChapter = () => {
    const paras = curParas;
    curParas = [];
    if (paras.join("").trim().length === 0) return;
    chapterIdx++;
    const startIdx = sections.length;
    let buf = "";
    const pushBuf = () => {
      if (buf.trim()) sections.push({ i: sections.length, chapter: chapterIdx, text: buf.trim() });
      buf = "";
    };
    for (const p of paras) {
      if (p.length > MAX) {
        // פסקה ענקית — חותכים במשפטים
        pushBuf();
        const sentences = p.split(/(?<=[.!?։؟。])\s+|(?<=[.!?])\s+/);
        for (const s of sentences) {
          if (buf.length + s.length > MAX && buf) pushBuf();
          buf += (buf ? " " : "") + s;
        }
        pushBuf();
        continue;
      }
      if (buf.length + p.length + 2 > MAX && buf) pushBuf();
      buf += (buf ? "\n\n" : "") + p;
      if (buf.length >= TARGET) pushBuf();
    }
    pushBuf();
    chapters.push({ title: curTitle, start: startIdx, end: sections.length - 1 });
  };

  for (const p of paragraphs) {
    if (isHeading(p)) {
      flushChapter();
      curTitle = p.replace(/^# /, "").trim();
      continue;
    }
    curParas.push(p);
  }
  flushChapter();

  // פרקים זעירים (תוצאה של כותרות-משנה, פסוקים, שורות דובר) — מאחדים לפרק הקודם
  const merged: Chapter[] = [];
  for (const c of chapters) {
    const len = sections.slice(c.start, c.end + 1).reduce((a, s) => a + s.text.length, 0);
    if (merged.length && len < MIN_CHAPTER) {
      merged[merged.length - 1].end = c.end;
      for (let i = c.start; i <= c.end; i++) sections[i].chapter = merged.length - 1;
    } else {
      for (let i = c.start; i <= c.end; i++) sections[i].chapter = merged.length;
      merged.push({ ...c });
    }
  }
  // פרק פתיחה זעיר (שער, שם המחבר) — מצרפים לפרק הראשון האמיתי
  if (merged.length > 1) {
    const first = merged[0];
    const len = sections.slice(first.start, first.end + 1).reduce((a, s) => a + s.text.length, 0);
    if (len < 600) {
      merged[1].start = first.start;
      merged.shift();
      for (const s of sections) s.chapter = Math.max(0, s.chapter - 1);
    }
  }
  // קטעים זעירים (פחות מ-250 תווים) — מצרפים לשכן באותו פרק, כדי לא להקריא "קטע" של שתי מילים
  const compact: Section[] = [];
  for (const s of sections) {
    const prev = compact[compact.length - 1];
    if (prev && prev.chapter === s.chapter && (prev.text.length < 250 || (s.text.length < 250 && prev.text.length + s.text.length <= MAX))) {
      prev.text = prev.text + "\n\n" + s.text;
    } else {
      compact.push({ ...s });
    }
  }
  compact.forEach((s, i) => (s.i = i));
  const finalChapters: Chapter[] = merged.map((c, ci) => {
    const idx = compact.filter((s) => s.chapter === ci).map((s) => s.i);
    return { title: c.title, start: idx[0] ?? 0, end: idx[idx.length - 1] ?? 0 };
  });
  return { chapters: finalChapters, sections: compact };
}

/** EPUB → פסקאות (לפי סדר הקריאה שב-OPF). */
export async function epubToParagraphs(data: Buffer): Promise<{ title?: string; author?: string; paragraphs: string[] }> {
  const zip = await JSZip.loadAsync(data);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error("EPUB בלי container.xml");
  const opf = await zip.file(opfPath)!.async("string");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const title = opf.match(/<dc:title[^>]*>([^<]+)</)?.[1]?.trim();
  const author = opf.match(/<dc:creator[^>]*>([^<]+)</)?.[1]?.trim();
  const items = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid="([^"]+)"/)?.[1];
    const href = m[0].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) items.set(id, decodeURIComponent(href));
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  const paragraphs: string[] = [];
  for (const id of spine) {
    const href = items.get(id);
    if (!href) continue;
    const f = zip.file(base + href) || zip.file(href);
    if (!f) continue;
    const html = await f.async("string");
    paragraphs.push(...htmlToParagraphs(html));
  }
  return { title, author, paragraphs };
}

export function htmlToParagraphs(html: string): string[] {
  let h = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  h = h.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
    const t = stripTags(inner).replace(/\s+/g, " ").trim();
    return t && t.length < 120 ? `\n\n# ${t}\n\n` : `\n\n${t}\n\n`;
  });
  h = h.replace(/<\/(p|div|li|blockquote|section|article|tr|br)>|<br\s*\/?>/gi, "\n\n");
  return toParagraphs(decodeEntities(stripTags(h)));
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, " ");
}
function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** פלט של Gemini בחילוץ PDF: כותרות מסומנות ב-"## " */
export function markdownToParagraphs(md: string): string[] {
  const paras = toParagraphs(md);
  return paras.map((p) => {
    if (!/^#{1,6} /.test(p)) return p;
    const t = p.replace(/^#{1,6} /, "").trim();
    return SPEAKER_RE.test(t) ? t : "# " + t; // שורת דובר שסומנה ככותרת → פסקה רגילה
  });
}
