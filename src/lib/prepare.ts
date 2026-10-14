// הכנה מראש: מייצרים שמע לקטעים מהמקום הנוכחי ועד סוף הפרק השני הבא, בסדר ההאזנה.
// רץ גם מהלקוח (כשהספר פתוח) וגם מ-cron (כשהאפליקציה סגורה); נעילה קצרה מונעת כפילות.
import * as store from "./storage";
import { getBook, getProgress, ensureAudio, ensureTranslation, type Book } from "./books";
import { genText, tts, SAMPLE_RATE, VOICE, TTS_VERSION } from "./gemini";
import { pcm16ToMp3 } from "./mp3";

export const CHAPTERS_AHEAD = 2;

const P = {
  lock: (id: string) => `books/${id}/prep.lock.json`,
  heMap: (id: string) => `books/${id}/he.json`,
  audioDir: (id: string, voice: string) => `books/${id}/audio/he/${voice}-${TTS_VERSION}/`,
  recap: (id: string, i: number, voice: string) => `books/${id}/recap/${voice}-${TTS_VERSION}/${i}`,
  question: (id: string, c: number, voice: string) => `books/${id}/questions/${voice}-${TTS_VERSION}-p6/${c}`, // p6 = עם 6 שניות שקט בסוף
  preview: (id: string, voice: string) => `books/${id}/preview/${voice}-${TTS_VERSION}.mp3`,
};

/** אילו קטעים כבר יש להם שמע בעברית בקול הזה. */
export async function readyMap(book: Book, voice: string): Promise<number[]> {
  const dir = P.audioDir(book.id, voice);
  const paths = await store.listPaths(dir);
  return paths
    .map((p) => p.slice(dir.length))
    .filter((f) => /^\d+\.mp3$/.test(f))
    .map((f) => Number(f.replace(".mp3", "")))
    .sort((a, b) => a - b);
}

/** טווח ההכנה: מהקטע הנוכחי עד סוף הפרק (current + CHAPTERS_AHEAD). */
export function targetRange(book: Book, section: number): [number, number] {
  const sec = book.sections[Math.min(section, book.sections.length - 1)];
  if (!sec) return [0, -1];
  const lastChapter = Math.min(book.chapters.length - 1, sec.chapter + CHAPTERS_AHEAD);
  const end = book.chapters[lastChapter]?.end ?? book.sections.length - 1;
  return [section, end];
}

export interface PrepResult {
  ready: number[];
  range: [number, number];
  total: number;
  busy: boolean; // מישהו אחר כבר מכין
  generated: number;
}

export async function prepare(id: string, opts: { voice?: string; budgetMs?: number; from?: number } = {}): Promise<PrepResult> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  const progress = await getProgress(id);
  const voice = opts.voice || progress.voice || VOICE;
  const from = opts.from ?? progress.section;
  const range = targetRange(book, from);
  let ready = await readyMap(book, voice);
  const readySet = new Set(ready);
  const todo: number[] = [];
  for (let i = range[0]; i <= range[1]; i++) if (!readySet.has(i)) todo.push(i);
  if (!book.background && book.lang !== "other") {
    // כרטיס רקע לשיחה — פעם אחת לספר, כדי שהשיחה הראשונה לא תחכה לו
    const { ensureBackground } = await import("./conversation");
    await ensureBackground(book).catch((e) => console.warn("background:", (e as Error).message));
  }
  if (!todo.length || book.lang === "other") {
    await mergeHeMap(book, ready);
    return { ready, range, total: book.sections.length, busy: false, generated: 0 };
  }

  // נעילה: אם מישהו אחר מכין עכשיו — לא מתחילים במקביל
  const lock = await store.readJSON<{ until: string }>(P.lock(id));
  if (lock && new Date(lock.until).getTime() > Date.now()) return { ready, range, total: book.sections.length, busy: true, generated: 0 };

  const budget = opts.budgetMs ?? 240_000;
  const start = Date.now();
  const setLock = () => store.writeJSON(P.lock(id), { until: new Date(Date.now() + 120_000).toISOString() });
  await setLock();
  let generated = 0;
  try {
    for (const i of todo) {
      if (Date.now() - start > budget) break;
      await ensureAudio(book, i, "he", voice);
      generated++;
      readySet.add(i);
      await setLock();
    }
  } finally {
    await store.remove(P.lock(id));
  }
  ready = [...readySet].sort((a, b) => a - b);
  await mergeHeMap(book, ready);
  return { ready, range, total: book.sections.length, busy: false, generated };
}

/** מפת התרגומים לתצוגה (קובץ אחד במקום מאות קריאות). */
export async function readHeMap(book: Book): Promise<Record<number, string>> {
  if (book.lang === "he") return Object.fromEntries(book.sections.map((s) => [s.i, s.text]));
  return (await store.readJSON<Record<number, string>>(P.heMap(book.id))) ?? {};
}

async function mergeHeMap(book: Book, ready: number[]) {
  if (book.lang === "he") return;
  const map = (await store.readJSON<Record<number, string>>(P.heMap(book.id))) ?? {};
  // קודם מה שמוכן לשמע, אחר כך כל השאר (תרגומים שנוצרו בעבר בקול אחר) — עד 120 בכל סיבוב
  const readySet = new Set(ready);
  const rest = book.sections.map((s) => s.i).filter((i) => !readySet.has(i));
  const missing = [...ready, ...rest].filter((i) => !map[i]).slice(0, 120);
  if (!missing.length) return;
  const texts = await Promise.all(missing.map((i) => store.readText(`books/${book.id}/he/${i}.txt`)));
  missing.forEach((i, k) => {
    if (texts[k]) map[i] = texts[k]!;
  });
  await store.writeJSON(P.heMap(book.id), map);
}

/** טקסט בעברית של קטעים (ממפת התרגומים, עם השלמה מהקבצים הבודדים). */
export async function heTexts(book: Book, idx: number[]): Promise<Record<number, string>> {
  const map = await readHeMap(book);
  const out: Record<number, string> = {};
  const missing: number[] = [];
  for (const i of idx) {
    if (map[i]) out[i] = map[i];
    else missing.push(i);
  }
  const texts = await Promise.all(missing.slice(0, 40).map((i) => store.readText(`books/${book.id}/he/${i}.txt`)));
  missing.slice(0, 40).forEach((i, k) => {
    if (texts[k]) out[i] = texts[k]!;
  });
  return out;
}

async function speak(text: string, voice: string, pathNoExt: string, trailingSilenceSec = 0): Promise<string> {
  const audioPath = pathNoExt + ".mp3";
  const existing = await store.exists(audioPath);
  if (existing) return existing;
  let pcm = await tts(text, "he", voice);
  // שקט בתוך הקובץ (ולא טיימר בדפדפן): בטלפון עם מסך כבוי טיימרים לא אמינים, שמע שמתנגן כן
  if (trailingSilenceSec > 0) pcm = Buffer.concat([pcm, Buffer.alloc(Math.round(SAMPLE_RATE * trailingSilenceSec) * 2)]);
  return store.writeBytes(audioPath, await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
}

/** תקציר קצר בחזרה אחרי הפסקה: מה שמעת עד הקטע הזה (לא מעבר). */
export async function recap(book: Book, upto: number, voice = VOICE): Promise<{ text: string; url: string }> {
  const base = P.recap(book.id, upto, voice);
  let text = await store.readText(base + ".txt");
  if (!text) {
    const from = Math.max(0, upto - 8);
    const idx = Array.from({ length: upto - from }, (_, k) => from + k);
    const he = await heTexts(book, idx);
    const body = idx.map((i) => he[i] ?? book.sections[i]?.text ?? "").join("\n\n").slice(0, 14000);
    const sys = "אתה מזכיר למאזין שחזר לספר אחרי הפסקה מה הוא שמע לאחרונה. עברית מדוברת, בלי ניקוד, בלי עיצוב, בלי רשימות. 60 עד 90 מילים. אל תגלה דבר שלא הופיע בקטעים.";
    text = await genText(`הספר: ${book.title}${book.author ? ` מאת ${book.author}` : ""}.\n\nהקטעים האחרונים שהמאזין שמע:\n${body}\n\nהתקציר:`, sys, 1024);
    await store.writeBytes(base + ".txt", text, "text/plain; charset=utf-8");
  }
  const url = await speak(text, voice, base);
  return { text, url };
}

/** שאלה אחת לסוף פרק — שליפה מהזיכרון, לא הסבר. */
export async function chapterQuestion(book: Book, c: number, voice = VOICE): Promise<{ text: string; url: string }> {
  const base = P.question(book.id, c, voice);
  let text = await store.readText(base + ".txt");
  if (!text) {
    const ch = book.chapters[c];
    if (!ch) throw new Error("אין פרק כזה");
    const idx = Array.from({ length: ch.end - ch.start + 1 }, (_, k) => ch.start + k);
    const he = await heTexts(book, idx);
    const body = idx.map((i) => he[i] ?? book.sections[i]?.text ?? "").join("\n\n").slice(0, 20000);
    const sys =
      "המאזין סיים עכשיו פרק בספר, ברכב. שאל שאלה אחת בלבד שגורמת לו להיזכר ולנסח במילים שלו רעיון מרכזי מהפרק. " +
      "עברית מדוברת, בלי ניקוד, בלי עיצוב. משפט פתיחה קצר של 3-5 מילים ואז השאלה. בסך הכל עד 30 מילים. בלי תשובה.";
    text = await genText(`הפרק "${ch.title}" מתוך "${book.title}":\n${body}\n\nהשאלה:`, sys, 512);
    await store.writeBytes(base + ".txt", text, "text/plain; charset=utf-8");
  }
  const url = await speak(text, voice, base, 6);
  return { text, url };
}

/** דוגמת קול: פסקה מהספר הנוכחי בקול מסוים (להשוואה בין קולות). */
export async function voicePreview(book: Book, voice: string): Promise<string> {
  const p = P.preview(book.id, voice);
  const existing = await store.exists(p);
  if (existing) return existing;
  const i = Math.min(1, book.sections.length - 1);
  const text = (book.lang === "he" ? book.sections[i].text : await ensureTranslation(book, i)).slice(0, 420);
  const pcm = await tts(text, "he", voice);
  return store.writeBytes(p, await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
}
