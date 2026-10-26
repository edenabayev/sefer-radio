// שעון שינה בצד השרת: רישום "לילה" (מאיפה הטיימר הופעל ועד איפה התנגן), רשימת הפסקאות שהתנגנו
// בזמן הזה עם השעה המשוערת של כל אחת, וסיכום "מה פספסתי" — של הלילה, או של מה ששמעת לאחרונה.
// כל סימון נשמר כקובץ נפרד (Blob מחזיר גרסה ישנה זמן מה אחרי דריסת קובץ באותו שם).
import * as store from "./storage";
import type { Book, Progress } from "./books";
import { audioDirFor, audioLang, heTexts, recap, speak } from "./prepare";
import { BYTES_PER_SEC } from "./stream";
import { genText, VOICE, TTS_VERSION } from "./gemini";

export interface SleepStart {
  id: string; // חותמת זמן — גם שם הקובץ
  startedAt: string;
  section: number; // איפה היית כשהפעלת את הטיימר
  offset: number; // שניות בתוך הקטע
  lang: "he" | "orig";
  voice: string; // הקול שהתנגן (לחישוב אורכי הקטעים)
  rate: number;
  minutes: number | null; // null = עד סוף הפרק
}

export interface Pos {
  section: number;
  offset: number;
}

export interface SleepSession extends SleepStart {
  fired?: Pos & { at: string };
  cancelled: boolean;
  done: boolean;
}

export interface SleepState {
  session: SleepSession | null;
  pending: boolean; // יש "לילה" שעוד לא טיפלו בו — להציג "איפה נרדמת?"
  end?: Pos; // איפה ההשמעה נעצרה
  endedAt?: string;
}

export interface NightParagraph {
  section: number;
  para: number;
  ratio: number; // המיקום היחסי של תחילת הפסקה בתוך הקטע (לקפיצה)
  clock: string; // ISO — השעה המשוערת שבה התחילה להתנגן
  text: string;
}

const dir = (bookId: string) => `books/${bookId}/sleep/`;
const MAX_AGE_MS = 4 * 24 * 3600 * 1000;
const CHAPTER_MODE_ASSUME_MS = 20 * 60 * 1000; // "עד סוף הפרק" בלי סימון עצירה — מניחים שנגמר אחרי 20 דק׳

export async function startSession(bookId: string, s: Omit<SleepStart, "id" | "startedAt">, now = Date.now()): Promise<SleepStart> {
  const start: SleepStart = { ...s, id: String(now), startedAt: new Date(now).toISOString() };
  await store.writeJSON(`${dir(bookId)}${start.id}.start.json`, start);
  return start;
}

export async function markSession(bookId: string, sid: string, kind: "fired" | "cancel" | "done", pos?: Pos, now = Date.now()) {
  if (!/^\d+$/.test(sid)) throw new Error("מזהה לא תקין");
  await store.writeJSON(`${dir(bookId)}${sid}.${kind}.json`, { at: new Date(now).toISOString(), ...(pos ?? {}) });
}

export async function latestSession(bookId: string): Promise<SleepSession | null> {
  const paths = await store.listPaths(dir(bookId));
  const marks = new Map<string, Set<string>>();
  for (const p of paths) {
    const m = p.slice(dir(bookId).length).match(/^(\d+)\.(start|fired|cancel|done)\.json$/);
    if (!m) continue;
    if (!marks.has(m[1])) marks.set(m[1], new Set());
    marks.get(m[1])!.add(m[2]);
  }
  const ids = [...marks.keys()].filter((k) => marks.get(k)!.has("start")).sort((a, b) => Number(b) - Number(a));
  if (!ids.length) return null;
  const sid = ids[0];
  const kinds = marks.get(sid)!;
  const start = await store.readJSON<SleepStart>(`${dir(bookId)}${sid}.start.json`);
  if (!start) return null;
  const fired = kinds.has("fired") ? await store.readJSON<Pos & { at: string }>(`${dir(bookId)}${sid}.fired.json`) : null;
  return { ...start, fired: fired ?? undefined, cancelled: kinds.has("cancel"), done: kinds.has("done") };
}

/** האם יש לילה פתוח, ועד איפה הוא הגיע. */
export function sessionState(session: SleepSession | null, progress: Progress, now = Date.now()): SleepState {
  if (!session) return { session: null, pending: false };
  const started = new Date(session.startedAt).getTime();
  if (session.cancelled || session.done || now - started > MAX_AGE_MS) return { session, pending: false };
  const timerOver =
    !!session.fired ||
    (session.minutes != null ? now >= started + session.minutes * 60_000 : now - started > CHAPTER_MODE_ASSUME_MS);
  if (!timerOver) return { session, pending: false };
  const end: Pos = session.fired
    ? { section: session.fired.section, offset: session.fired.offset }
    : { section: progress.section, offset: progress.offset };
  const endedAt = session.fired?.at ?? (session.minutes != null ? new Date(started + session.minutes * 60_000).toISOString() : progress.updatedAt);
  // חייבת להיות התקדמות כלשהי מאז שהטיימר הופעל — אחרת אין "לילה"
  const progressed = end.section > session.section || (end.section === session.section && end.offset > session.offset + 20);
  return { session, pending: progressed, end, endedAt };
}

/** אורך כל קטע בשניות (מגודל קובץ ה-MP3, שהוא בקצב קבוע), ואם אין קובץ — הערכה לפי אורך הטקסט. */
async function sectionSeconds(book: Book, lang: "he" | "en", voice: string, texts: Record<number, string>, idx: number[]) {
  const d = audioDirFor(book, voice, lang);
  const files = await store.listFiles(d);
  const sizes = new Map<number, number>();
  for (const f of files) {
    const m = f.path.slice(d.length).match(/^(\d+)\.mp3$/);
    if (m) sizes.set(Number(m[1]), f.size);
  }
  const out: Record<number, number> = {};
  for (const i of idx) {
    const size = sizes.get(i);
    out[i] = size ? size / BYTES_PER_SEC : Math.max(10, (texts[i] ?? book.sections[i]?.text ?? "").length / 14);
  }
  return out;
}

/** הטקסט של קטע בשפה שבה הקשבת. */
async function textsFor(book: Book, lang: "he" | "en", idx: number[]): Promise<Record<number, string>> {
  if (lang === "he" && book.lang !== "he") {
    const he = await heTexts(book, idx);
    const out: Record<number, string> = {};
    for (const i of idx) out[i] = he[i] ?? book.sections[i]?.text ?? "";
    return out;
  }
  return Object.fromEntries(idx.map((i) => [i, book.sections[i]?.text ?? ""]));
}

const paragraphs = (t: string) => t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

/** הפסקאות שהתנגנו מאז שהפעלת את הטיימר ועד שההשמעה נעצרה, עם השעה המשוערת של כל אחת. */
export async function nightParagraphs(book: Book, session: SleepStart, end: Pos): Promise<NightParagraph[]> {
  const lang = audioLang(book, session.lang);
  const last = Math.min(end.section, book.sections.length - 1);
  if (last < session.section) return [];
  const idx = Array.from({ length: last - session.section + 1 }, (_, k) => session.section + k);
  const texts = await textsFor(book, lang, idx);
  const secs = await sectionSeconds(book, lang, session.voice, texts, idx);
  const rate = session.rate > 0 ? session.rate : 1;
  const t0 = new Date(session.startedAt).getTime();
  const out: NightParagraph[] = [];
  let elapsed = 0; // שניות שמע מאז נקודת ההתחלה
  for (const i of idx) {
    const dur = secs[i];
    const ps = paragraphs(texts[i]);
    const total = ps.reduce((n, p) => n + p.length + 2, 0) || 1;
    let before = 0;
    const secStart = i === session.section ? session.offset : 0;
    const secEnd = i === end.section ? end.offset : dur;
    ps.forEach((p, k) => {
      const ratio = before / total;
      const nextRatio = (before + p.length + 2) / total;
      before += p.length + 2;
      const pStart = ratio * dur;
      const pEnd = nextRatio * dur;
      if (pEnd <= secStart || pStart >= secEnd) return; // לא התנגנה בלילה הזה
      const at = t0 + ((elapsed + Math.max(0, pStart - secStart)) / rate) * 1000;
      out.push({ section: i, para: k, ratio, clock: new Date(at).toISOString(), text: p.length > 160 ? p.slice(0, 157) + "…" : p });
    });
    elapsed += Math.max(0, secEnd - secStart);
  }
  return out;
}

/** הטקסט שבין שתי נקודות (לסיכום). */
async function rangeText(book: Book, session: SleepStart, end: Pos, maxChars = 40000): Promise<string> {
  const lang = audioLang(book, session.lang);
  const last = Math.min(end.section, book.sections.length - 1);
  const idx = Array.from({ length: Math.max(0, last - session.section + 1) }, (_, k) => session.section + k);
  const texts = await textsFor(book, lang, idx);
  const secs = await sectionSeconds(book, lang, session.voice, texts, idx);
  const parts: string[] = [];
  for (const i of idx) {
    const t = texts[i];
    const from = i === session.section ? Math.floor((session.offset / secs[i]) * t.length) : 0;
    const to = i === end.section ? Math.ceil((end.offset / secs[i]) * t.length) : t.length;
    // מרחיבים לגבולות משפט כדי לא לחתוך באמצע
    const a = Math.max(0, t.lastIndexOf(" ", Math.max(0, from - 1)));
    const bIdx = t.indexOf(" ", Math.min(t.length, to));
    parts.push(t.slice(a, bIdx < 0 ? t.length : bIdx).trim());
  }
  const all = parts.filter(Boolean).join("\n\n");
  return all.length > maxChars ? all.slice(0, maxChars / 2) + "\n\n[…]\n\n" + all.slice(-maxChars / 2) : all;
}

export interface Missed {
  kind: "sleep" | "recent";
  text: string;
  url: string;
}

/** "מה פספסתי": אם ההאזנה האחרונה נגמרה בשעון שינה — סיכום של מה שהתנגן בזמן הזה; אחרת — של מה ששמעת לאחרונה. */
export async function missed(book: Book, progress: Progress, now = Date.now()): Promise<Missed> {
  const voice = progress.voice || VOICE; // הסיכום תמיד בעברית
  const state = sessionState(await latestSession(book.id), progress, now);
  if (state.pending && state.session && state.end) {
    const s = state.session;
    const base = `books/${book.id}/missed/${voice}-${TTS_VERSION}/${s.id}-${state.end.section}-${Math.round(state.end.offset)}`;
    let text = await store.readText(base + ".txt");
    if (!text) {
      const body = await rangeText(book, s, state.end);
      const minutes = Math.max(1, Math.round((new Date(state.endedAt ?? now).getTime() - new Date(s.startedAt).getTime()) / 60000));
      const words = minutes <= 15 ? "60 עד 100" : minutes <= 40 ? "90 עד 150" : "120 עד 200";
      const sys =
        "המאזין נרדם בזמן שהספר המשיך להתנגן. ספר לו בעברית מדוברת מה קרה בחלק שהתנגן, לפי הסדר, כדי שיבין מה פספס ויוכל לבחור מאיפה להמשיך. " +
        `${words} מילים. בלי ניקוד, בלי עיצוב, בלי רשימות. פתח במשפט קצר כמו "בזמן שישנת…". אל תספר שום דבר שלא מופיע בטקסט, ואל תגלה מה קורה אחריו.`;
      text = await genText(`הספר: ${book.title}${book.author ? ` מאת ${book.author}` : ""}.\n\nמה שהתנגן בזמן שהמאזין ישן (בערך ${minutes} דקות):\n${body}\n\nהסיכום:`, sys, 1536);
      await store.writeBytes(base + ".txt", text, "text/plain; charset=utf-8");
    }
    return { kind: "sleep", text, url: await speak(text, voice, base) };
  }
  const upto = Math.min(book.sections.length, Math.max(1, progress.section + (progress.offset > 30 ? 1 : 0)));
  const r = await recap(book, upto, voice);
  return { kind: "recent", ...r };
}
