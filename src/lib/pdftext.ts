// קריאת PDF שיש בו שכבת טקסט — כאן על השרת, בלי בינה מלאכותית: מהיר, בחינם, ובלי סירוב של גוגל ל"טקסט מוגן".
// משחזרים פסקאות לפי המיקומים בעמוד: רווח אנכי גדול או הזחה בתחילת שורה = פסקה חדשה; גופן גדול = כותרת;
// מספרי עמוד וכותרות רצות (שורה שחוזרת בראש/בתחתית עמודים) נזרקים; מילה שנחתכה במקף בסוף שורה מתחברת;
// פסקה שנמשכת לעמוד הבא מתחברת. התוצאה — טקסט עם "## " לכותרות ושורה ריקה בין פסקאות (כמו מה שגוגל מחזיר).
import { LIGATURE_WORDS } from "./ligature-words";
import { genJson, MODELS, MOCK } from "./gemini";

export interface PdfItem {
  str: string;
  x: number;
  y: number;
  size: number;
  w: number;
  rtl?: boolean;
}
export interface PdfLine {
  text: string;
  x: number;
  xEnd: number;
  y: number;
  size: number;
}
export interface PdfPage {
  n: number;
  width: number;
  lines: PdfLine[];
}

const r1 = (v: number) => Math.round(v * 2) / 2;

/** פריטי טקסט של עמוד → שורות (לפי גובה), כל שורה מסודרת לפי כיוון הכתיבה. */
export function itemsToLines(items: PdfItem[]): PdfLine[] {
  const its = items.filter((i) => i.str && i.str.trim() !== "" && i.size > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PdfItem[][] = [];
  for (const it of its) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].y - it.y) <= Math.max(2, 0.45 * Math.min(g[0].size, it.size))) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => {
    const rtl = g.filter((i) => i.rtl).length > g.length / 2;
    const sorted = g.slice().sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
    let text = "";
    let prev: PdfItem | null = null;
    for (const it of sorted) {
      if (prev) {
        const gap = rtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w);
        if (gap > 0.18 * it.size && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
      }
      text += it.str;
      prev = it;
    }
    const x = Math.min(...g.map((i) => i.x));
    const xEnd = Math.max(...g.map((i) => i.x + i.w));
    // גודל השורה: של הפריט הארוך ביותר (מספר הערה קטן לא משנה אותו)
    const size = g.slice().sort((a, b) => b.str.length - a.str.length)[0].size;
    return { text: text.replace(/\s+/g, " ").trim(), x, xEnd, y: g[0].y, size };
  });
}

const TERMINAL = /[.!?…:"”’'»)\]]$/;
const isPageNumber = (t: string) => /^[\s\-–—(\[]*(\d{1,4}|[ivxlcdm]{1,7})[\s\-–—)\]]*$/i.test(t);
const keyOf = (t: string) => t.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

function mode(values: number[]): number {
  const m = new Map<number, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let n = -1;
  for (const [v, c] of m) if (c > n || (c === n && v < best)) [best, n] = [v, c];
  return best;
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** עמודים (שורות עם מיקום) → טקסט עם כותרות ופסקאות. */
export function pagesToMarkdown(pages: PdfPage[]): string {
  const all = pages.flatMap((p) => p.lines);
  if (!all.length) return "";
  // גודל הגופן של גוף הטקסט: הנפוץ ביותר, משוקלל באורך
  const weighted: number[] = [];
  for (const l of all) for (let k = 0; k < Math.ceil(l.text.length / 20); k++) weighted.push(r1(l.size));
  const body = mode(weighted) || 10;
  const isBody = (l: PdfLine) => Math.abs(r1(l.size) - body) <= Math.max(0.6, body * 0.08);

  // כותרות רצות: השורה הראשונה/האחרונה בעמוד שחוזרת (בלי מספרים) בכמה עמודים
  const edgeCount = new Map<string, number>();
  for (const p of pages) {
    const edges = [p.lines[0], p.lines[1], p.lines[p.lines.length - 1], p.lines[p.lines.length - 2]].filter(Boolean) as PdfLine[];
    for (const k of new Set(edges.map((l) => keyOf(l.text)))) edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  }
  const minRepeat = Math.max(3, Math.ceil(pages.length * 0.2));
  const isRunning = (t: string) => t.length <= 90 && (edgeCount.get(keyOf(t)) ?? 0) >= minRepeat;

  // השוליים: לפי השורות בעמוד עצמו; בעמוד עם מעט שורות — לפי כל העמודים הזוגיים/האי-זוגיים (בספרים השוליים מתחלפים)
  const byParity: number[][] = [[], []];
  for (const p of pages) for (const l of p.lines.filter(isBody)) byParity[p.n % 2].push(Math.round(l.x));
  const anyMargin = mode([...byParity[0], ...byParity[1]]);
  const parityMargin = byParity.map((xs) => (xs.length ? mode(xs) : anyMargin));
  // סגנון הספר: פסקאות עם הזחה, או פסקאות "בלוק" עם רווח ביניהן
  let indented = 0;
  let bodyLines = 0;
  const margins = new Map<number, number>();
  for (const p of pages) {
    const bl = p.lines.filter(isBody);
    const m = bl.length >= 8 ? mode(bl.map((l) => Math.round(l.x))) : parityMargin[p.n % 2];
    margins.set(p.n, m);
    for (const l of bl) {
      bodyLines++;
      if (l.x > m + Math.max(6, 0.8 * body) && l.x < m + p.width * 0.3) indented++;
    }
  }
  const indentStyle = bodyLines > 0 && indented / bodyLines >= 0.04;

  const paras: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) paras.push(t);
    cur = "";
  };
  const append = (text: string) => {
    if (!cur) cur = text;
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(text)) cur = cur.slice(0, -1) + text; // מילה שנחתכה במקף בסוף שורה
    else cur += " " + text;
  };
  let lastWasHeading = false;

  for (const p of pages) {
    const margin = margins.get(p.n) ?? 0;
    const lines = p.lines.filter((l, k) => {
      const edge = k <= 1 || k >= p.lines.length - 2;
      if (edge && isPageNumber(l.text)) return false;
      if (edge && l.size <= body * 1.08 && isRunning(l.text)) return false; // כותרת פרק ("Chapter 3") גדולה מהטקסט — לא כותרת רצה
      return true;
    });
    const bl = lines.filter(isBody);
    const right = Math.max(...bl.map((l) => l.xEnd), 0);
    const gaps: number[] = [];
    for (let k = 1; k < bl.length; k++) {
      const d = bl[k - 1].y - bl[k].y;
      if (d > 0) gaps.push(d);
    }
    const spacing = median(gaps) || body * 1.2;
    let prev: PdfLine | null = null;
    for (const l of lines) {
      const heading = l.size >= body * 1.18 && l.text.length <= 120 && !/[.,;]$/.test(l.text);
      if (heading) {
        if (lastWasHeading && prev && prev.y - l.y < l.size * 2.2) {
          paras[paras.length - 1] += " " + l.text; // כותרת בשתי שורות
        } else {
          flush();
          paras.push("## " + l.text);
        }
        lastWasHeading = true;
        prev = l;
        continue;
      }
      const isIndented = l.x > margin + Math.max(6, 0.8 * body) && l.x < margin + p.width * 0.3;
      const centered = Math.abs((l.x + l.xEnd) / 2 - p.width / 2) < p.width * 0.06 && l.xEnd - l.x < p.width * 0.4 && l.x > margin + p.width * 0.15;
      let newPara: boolean;
      if (lastWasHeading || !cur) newPara = true;
      else if (centered) newPara = true;
      else if (!prev) {
        // שורה ראשונה בעמוד: ממשיכה את הפסקה מהעמוד הקודם, אלא אם יש הזחה (או, בלי הזחות בספר, אם הקודמת נגמרה במשפט שלם)
        newPara = indentStyle ? isIndented : TERMINAL.test(cur) && /^[A-Z"“'‘(\[]/.test(l.text);
      } else {
        const gap = prev.y - l.y;
        const prevShort = right > 0 && prev.xEnd < right - (right - margin) * 0.15;
        newPara = gap > spacing * 1.45 || (indentStyle && isIndented) || (!indentStyle && prevShort && TERMINAL.test(prev.text)) || (prevCentered(prev, p, margin) && !centered);
      }
      if (newPara) flush();
      append(l.text);
      if (centered) flush();
      lastWasHeading = false;
      prev = l;
    }
  }
  flush();
  return paras.join("\n\n");
}

function prevCentered(l: PdfLine, p: PdfPage, margin: number) {
  return Math.abs((l.x + l.xEnd) / 2 - p.width / 2) < p.width * 0.06 && l.xEnd - l.x < p.width * 0.4 && l.x > margin + p.width * 0.15;
}

// ---------- צירופי אותיות שנעלמו (fi, fl, ff, ffi, ffl) ----------

let ligSet: Set<string> | null = null;
const LIG_OPTIONS = ["fi", "fl", "ff", "ffi", "ffl"]; // לפי השכיחות
const UNICODE_LIG: Record<string, string> = { "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st" };

/** ב-PDF שבו "fi" מודפס כאות אחת בלי מיפוי לטקסט, המילה יוצאת "\u0000sherman". משחזרים לפי רשימת מילים באנגלית
 *  (fisherman, different, flowers…); מילה שלא נמצאת ברשימה (שם, למשל) מקבלת את הצירוף הנפוץ — fi. */
export function repairLigatures(text: string): string {
  let t = text.replace(/[\uFB00-\uFB06]/g, (c) => UNICODE_LIG[c] ?? c);
  if (!t.includes("\u0000")) return t;
  ligSet ??= new Set(LIGATURE_WORDS.split(" "));
  const dict = ligSet;
  t = t.replace(/[\p{L}'’]*\u0000[\p{L}'’\u0000]*/gu, (tok) => {
    const parts = tok.split("\u0000");
    const holes = parts.length - 1;
    const combos: string[][] = holes <= 2 ? cartesian(holes) : [Array(holes).fill("fi")];
    for (const c of combos) {
      const word = parts.reduce((acc, p, k) => acc + p + (k < holes ? c[k] : ""), "");
      const core = word.replace(/['’]s$/i, "").replace(/['’]/g, "");
      const plain = core.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (dict.has(plain)) return word;
    }
    // לא ברשימה (שם, למשל): בין שתי תנועות זה כמעט תמיד ff ("Ja?a" → Jaffa), אחרת fi
    return parts.reduce((acc, p, k) => {
      if (k === parts.length - 1) return acc + p;
      const before = (acc + p).slice(-1);
      const after = parts[k + 1].slice(0, 1);
      return acc + p + (/[aeiou]/i.test(before) && /[aeiou]/i.test(after) ? "ff" : "fi");
    }, "");
  });
  return t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
function cartesian(n: number): string[][] {
  if (n === 0) return [[]];
  const rest = cartesian(n - 1);
  return LIG_OPTIONS.flatMap((o) => rest.map((r) => [o, ...r]));
}

// ---------- אות ראשונה מעוטרת שנעלמה ----------

/** פרק שמתחיל באות גדולה מעוטרת (תמונה, לא טקסט) יוצא "t is said…" במקום "It is said…".
 *  מוצאים פסקאות כאלה (אחרי כותרת, מתחילות באות קטנה) ומבקשים מהמודל רק את מה שחסר בהתחלה — אות אחת או "A "/"I ". */
export async function fixDropCaps(markdown: string): Promise<string> {
  const paras = markdown.split("\n\n");
  const idx: number[] = [];
  paras.forEach((p, k) => {
    if (/^[a-z]/.test(p) && (k === 0 || paras[k - 1].startsWith("## "))) idx.push(k);
  });
  if (!idx.length || MOCK) return markdown;
  const r = await genJson<{ prefixes: string[] }>(
    "Each line below is the opening of a book chapter whose large decorative first letter (drop cap) was lost when the text was extracted. " +
      "For each line, return ONLY the text missing before it: usually one capital letter (\"t is said\" → \"I\"), or a one-letter word plus a space (\"long time ago\" → \"A \"), " +
      "with an opening quotation mark first if the line is the middle of a quotation (\"h Commander of the Faithful,” she said\" → \"“O\"). " +
      "Return the prefixes in the same order.\n\n" +
      idx.map((k, n) => `${n + 1}. ${paras[k].slice(0, 90)}`).join("\n"),
    "You restore lost drop caps. Answer only with the requested JSON.",
    { type: "object", properties: { prefixes: { type: "array", items: { type: "string", maxLength: 4 }, maxItems: idx.length } }, required: ["prefixes"] },
    { prefixes: [] },
    MODELS.text,
    undefined,
    // משימה זעירה: תשובה קצרה, מעט חשיבה, ובלי לחכות דקות אם המודל נתקע (אז פשוט לא משחזרים)
    { maxOutputTokens: 1500, timeoutMs: 40_000, thinking: "LOW", fallback: false },
  ).catch((e) => {
    console.warn("drop caps:", (e as Error).message);
    return { prefixes: [] as string[] };
  });
  idx.forEach((k, n) => {
    const pre = r.prefixes?.[n] ?? "";
    if (/^[“"‘']?[A-Z]( )?$/.test(pre)) paras[k] = pre + paras[k]; // גם עם מרכאות פותחות: "“O" + "h Commander…"
  });
  return paras.join("\n\n");
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsP: Promise<PdfJs> | null = null;
// ה-"worker" של pdf.js נטען קודם (מגדיר globalThis.pdfjsWorker) — כך הוא רץ באותו תהליך, בלי לחפש קובץ בזמן ריצה
const loadPdfJs = () => (pdfjsP ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs").then(() => import("pdfjs-dist/legacy/build/pdf.mjs")));

/** קורא עמודים from..to (כולל, מ-1) עם מיקומי הטקסט. */
export async function readPdfPages(pdf: Buffer | Uint8Array, from: number, to: number): Promise<PdfPage[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const out: PdfPage[] = [];
    const last = Math.min(to, doc.numPages);
    for (let n = Math.max(1, from); n <= last; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const it of tc.items as { str?: string; transform?: number[]; width?: number; dir?: string }[]) {
        if (typeof it.str !== "string" || !it.transform) continue;
        const [a, b, , d, e, f] = it.transform;
        const size = Math.hypot(b, d) || Math.abs(a);
        items.push({ str: it.str, x: e, y: f, size, w: it.width ?? 0, rtl: it.dir === "rtl" });
      }
      out.push({ n, width: vp.width, lines: itemsToLines(items) });
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/** טקסט של טווח עמודים, ומדד: כמה תווים יצאו (בלי שכבת טקסט — כמעט אפס). */
export async function extractPdfText(pdf: Buffer | Uint8Array, from: number, to: number): Promise<{ markdown: string; chars: number; pages: number }> {
  const pages = await readPdfPages(pdf, from, to);
  const markdown = pagesToMarkdown(pages);
  return { markdown, chars: markdown.replace(/\s+/g, "").length, pages: pages.length };
}

/** רוב הטקסט בעברית — שם עדיף לנסות קודם את גוגל (סדר האותיות בעברית ב-PDF לא תמיד אמין). */
export const isHebrewText = (t: string) => {
  const he = (t.match(/[֐-׿]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  return he > lat;
};
