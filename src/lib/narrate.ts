// צינור ההקראה — מה שהגדולים עושים לפני ואחרי מנוע הקול:
// 1. ניקוי: קיצורים, מספרים, שורות שבורות, מרכאות.   2. חיתוך למשפטים אמיתיים וקיבוץ לחתיכות בגודל נוח.
// 3. קיצוץ שקט בקצוות של כל חתיכה.   4. הפסקות לפי סוג הגבול (משפט / פסקה / כותרת / חיתוך כפוי).
import { SAMPLE_RATE } from "./gemini";

export type Boundary = "sentence" | "paragraph" | "heading" | "forced" | "end";

export interface Chunk {
  text: string;
  after: Boundary; // מה בא אחרי החתיכה הזאת — קובע את אורך ההפסקה
}

export interface ChunkPlan {
  targetChars: number; // גודל נוח
  maxChars: number; // מעבר לזה — חותכים משפט בפסיק/מקף
  measure?: (s: string) => number; // ברירת מחדל: תווים; ל-Gemini — בייטים
}

// ---------- 1. ניקוי ----------

const ABBREV_EN: [RegExp, string][] = [
  [/\bMr\./g, "Mister"],
  [/\bMrs\./g, "Missus"],
  [/\bMs\./g, "Miss"],
  [/\bDr\./g, "Doctor"],
  [/\bProf\./g, "Professor"],
  [/\bSt\.(?=\s+[A-Z])/g, "Saint"],
  [/\bMt\.(?=\s+[A-Z])/g, "Mount"],
  [/\bJr\./g, "Junior"],
  [/\bSr\./g, "Senior"],
  [/\bCapt\./g, "Captain"],
  [/\bLt\./g, "Lieutenant"],
  [/\bSgt\./g, "Sergeant"],
  [/\bCol\./g, "Colonel"],
  [/\bGen\.(?=\s+[A-Z])/g, "General"],
  [/\bRev\./g, "Reverend"],
  [/\bHon\./g, "Honorable"],
  [/\bAve\./g, "Avenue"],
  [/\bBlvd\./g, "Boulevard"],
  [/\bNo\.(?=\s*\d)/g, "Number"],
  [/\bvs\./g, "versus"],
  [/\betc\./g, "et cetera"],
  [/\be\.g\./g, "for example"],
  [/\bi\.e\./g, "that is"],
  [/\ba\.m\./gi, "A M"],
  [/\bp\.m\./gi, "P M"],
];

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return "minus " + numberToWords(-n);
  if (n < 20) return n === 0 ? "zero" : ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + numberToWords(n % 100) : "");
  const units: [number, string][] = [
    [1e9, "billion"],
    [1e6, "million"],
    [1e3, "thousand"],
  ];
  for (const [v, name] of units) {
    if (n >= v) {
      const head = Math.floor(n / v);
      const rest = n % v;
      return numberToWords(head) + " " + name + (rest ? " " + numberToWords(rest) : "");
    }
  }
  return String(n);
}

/** שנה כמו שאומרים אותה: 1951 → nineteen fifty-one, 2008 → two thousand eight, 1900 → nineteen hundred. */
export function yearToWords(y: number): string {
  if (y < 1000 || y > 2999) return numberToWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (y >= 2000 && y < 2010) return numberToWords(y);
  if (lo === 0) return numberToWords(hi) + " hundred";
  if (lo < 10) return numberToWords(hi) + " oh " + numberToWords(lo);
  return numberToWords(hi) + " " + numberToWords(lo);
}

function ordinalToWords(n: number): string {
  const w = numberToWords(n);
  const special: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  const last = w.split(/[\s-]/).pop()!;
  if (special[last]) return w.slice(0, w.length - last.length) + special[last];
  if (last.endsWith("y")) return w.slice(0, -1) + "ieth";
  return w + "th";
}

function normalizeNumbersEn(t: string): string {
  return t
    .replace(/\$(\d[\d,]*)(?:\.(\d\d))?/g, (_m, d: string, c?: string) => {
      const n = Number(d.replace(/,/g, ""));
      const dollars = numberToWords(n) + (n === 1 ? " dollar" : " dollars");
      return c && Number(c) ? dollars + " and " + numberToWords(Number(c)) + " cents" : dollars;
    })
    .replace(/(\d+)%/g, (_m, d: string) => numberToWords(Number(d)) + " percent")
    .replace(/\b(\d{1,2}):(\d\d)\b/g, (_m, h: string, m: string) => numberToWords(Number(h)) + (m === "00" ? " o'clock" : Number(m) < 10 ? " oh " + numberToWords(Number(m)) : " " + numberToWords(Number(m))))
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, (_m, d: string) => ordinalToWords(Number(d)))
    .replace(/\b(1[0-9]\d\d|20\d\d)\b/g, (m) => yearToWords(Number(m)))
    .replace(/\b(\d+)\.(\d+)\b/g, (_m, a: string, b: string) => numberToWords(Number(a)) + " point " + [...b].map((d) => numberToWords(Number(d))).join(" "))
    .replace(/\b\d[\d,]*\b/g, (m) => {
      const n = Number(m.replace(/,/g, ""));
      return Number.isFinite(n) && n < 1e12 ? numberToWords(n) : m;
    });
}

/** ניקוי לדיבור. פסקאות נשארות מופרדות ב-\n\n; שורות שבורות בתוך פסקה מתאחדות. */
export function normalizeForSpeech(text: string, lang: "he" | "en"): string {
  let t = text
    .replace(/\r\n/g, "\n")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[*_#>`]+/g, "")
    .replace(/ /g, " ")
    .replace(/https?:\/\/\S+/g, "");
  // שורות בודדות בתוך פסקה → רווח (פסקאות נשארות)
  t = t
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (lang === "en") {
    for (const [re, rep] of ABBREV_EN) t = t.replace(re, rep);
    t = t.replace(/\b(?:[A-Z]\.){2,}/g, (m) => m.replace(/\./g, " ").trim()); // U.S. → U S
    t = normalizeNumbersEn(t);
    t = t.replace(/\s*[–—]\s*|\s+-\s+/g, ", "); // מקף ארוך = הפסקה קצרה
    t = t.replace(/\.{3,}|…/g, "..."); // שלוש נקודות — המנוע מכיר כהיסוס
  } else {
    t = t.replace(/\s[–—-]\s/g, ", ").replace(/…/g, ".");
  }
  return t.replace(/ +([,.;:!?])/g, "$1").replace(/[ \t]+/g, " ").trim();
}

// ---------- 2. משפטים וחתיכות ----------

const ABBREV_TAIL = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Mt|Jr|Sr|Capt|Lt|Sgt|Col|Gen|Rev|Hon|Ave|Blvd|No|vs|etc|e\.g|i\.e|[A-Z])\.\s*$/;

export function sentences(paragraph: string, lang: "he" | "en"): string[] {
  const seg = new Intl.Segmenter(lang === "he" ? "he" : "en", { granularity: "sentence" });
  const out: string[] = [];
  for (const { segment } of seg.segment(paragraph)) {
    const s = segment.trim();
    if (!s) continue;
    const prev = out[out.length - 1];
    // קיצור בסוף (Mr. / U.S. / No.) — זה לא סוף משפט, מצרפים לבא אחריו
    if (prev && ABBREV_TAIL.test(prev)) out[out.length - 1] = prev + " " + s;
    else out.push(s);
  }
  return out;
}

/** משפט ארוך מדי — חותכים בפסיק/נקודה-פסיק/מקף הקרוב לאמצע, ואם אין — ברווח. */
function splitLong(s: string, max: number, measure: (x: string) => number): string[] {
  if (measure(s) <= max) return [s];
  const mid = Math.floor(s.length / 2);
  let best = -1;
  for (const m of s.matchAll(/[,;:]\s/g)) {
    const idx = m.index + 1;
    if (best < 0 || Math.abs(idx - mid) < Math.abs(best - mid)) best = idx;
  }
  if (best < 0) {
    const sp = s.lastIndexOf(" ", mid);
    best = sp > 0 ? sp : mid;
  }
  const a = s.slice(0, best).trim();
  const b = s.slice(best).trim();
  if (!a || !b) return [s];
  return [...splitLong(a, max, measure), ...splitLong(b, max, measure)];
}

/** מתכנן חתיכות: אף פעם לא חותך משפט (אלא אם הוא ענק), מסמן מה בא אחרי כל חתיכה. */
export function planChunks(text: string, lang: "he" | "en", plan: ChunkPlan, opts: { headingFirst?: boolean } = {}): Chunk[] {
  const measure = plan.measure ?? ((s: string) => s.length);
  const paras = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const out: Chunk[] = [];
  paras.forEach((p, pi) => {
    const isLastPara = pi === paras.length - 1;
    const paraEnd: Boundary = isLastPara ? "end" : "paragraph";
    if (pi === 0 && opts.headingFirst) {
      out.push({ text: p, after: isLastPara ? "end" : "heading" });
      return;
    }
    const pieces: { text: string; forced: boolean }[] = [];
    for (const s of sentences(p, lang)) {
      const parts = splitLong(s, plan.maxChars, measure);
      parts.forEach((part, k) => pieces.push({ text: part, forced: k < parts.length - 1 }));
    }
    let buf = "";
    const flush = (after: Boundary) => {
      if (buf) out.push({ text: buf, after });
      buf = "";
    };
    pieces.forEach((piece, k) => {
      const isLast = k === pieces.length - 1;
      const joined = buf ? buf + " " + piece.text : piece.text;
      if (buf && measure(joined) > plan.targetChars) flush("sentence");
      buf = buf ? buf + " " + piece.text : piece.text;
      if (piece.forced) flush("forced");
      else if (isLast) flush(paraEnd);
      else if (measure(buf) >= plan.targetChars) flush("sentence");
    });
    flush(paraEnd);
  });
  if (out.length) out[out.length - 1].after = "end";
  return out;
}

// ---------- 3+4. שקט והפסקות ----------

/** מקצץ שקט בתחילת ובסוף (חלונות של 10ms מתחת לסף), משאיר שוליים קטנים. */
export function trimSilence(pcm: Buffer, opts: { threshold?: number; keepMs?: number; rate?: number } = {}): Buffer {
  const rate = opts.rate ?? SAMPLE_RATE;
  const threshold = opts.threshold ?? 0.012;
  const keep = Math.round(((opts.keepMs ?? 60) / 1000) * rate);
  const win = Math.round(rate / 100);
  const n = Math.floor(pcm.length / 2);
  if (n < win * 3) return pcm;
  const rms = (from: number) => {
    let s = 0;
    for (let i = from; i < from + win && i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      s += v * v;
    }
    return Math.sqrt(s / win);
  };
  let start = 0;
  while (start + win < n && rms(start) < threshold) start += win;
  let end = n;
  while (end - win > start && rms(end - win) < threshold) end -= win;
  start = Math.max(0, start - keep);
  end = Math.min(n, end + keep);
  return pcm.subarray(start * 2, end * 2);
}

export function pauseSeconds(after: Boundary): number {
  switch (after) {
    case "sentence":
      return 0.25;
    case "paragraph":
      return 0.7;
    case "heading":
      return 1.4;
    case "forced":
      return 0;
    case "end":
      return 0.35;
  }
}

export function silence(seconds: number, rate = SAMPLE_RATE): Buffer {
  return Buffer.alloc(Math.max(0, Math.round(seconds * rate)) * 2);
}

/** מריץ את הצינור: מנתח → מקריא כל חתיכה → מקצץ שקט → מדביק עם הפסקות לפי הגבול. */
export async function narrate(
  text: string,
  lang: "he" | "en",
  plan: ChunkPlan,
  synth: (chunk: string) => Promise<Buffer>,
  opts: { headingFirst?: boolean } = {},
): Promise<Buffer> {
  const chunks = planChunks(text, lang, plan, opts);
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const pcm = trimSilence(await synth(c.text));
    parts.push(pcm, silence(pauseSeconds(c.after)));
  }
  return Buffer.concat(parts);
}
