// הכנה מראש: מייצרים שמע לקטעים מהמקום הנוכחי ועד סוף הפרק השני הבא, בסדר ההאזנה.
// רץ גם מהלקוח (כשהספר פתוח) וגם מ-cron (כשהאפליקציה סגורה); נעילה קצרה מונעת כפילות.
import * as store from "./storage";
import { getBook, getProgress, ensureAudio, ensureTranslation, heAudioDir, heDir, heFixDir, heMapPath, heTextPath, prefetchSpokenText, trSuffix, type Book } from "./books";
import { genText, tts, SAMPLE_RATE, VOICE, TTS_VERSION } from "./gemini";
import { pcm16ToMp3 } from "./mp3";
import { KOKORO_VERSION, KOKORO_DEFAULT, isKokoroVoice } from "./kokoro-voices";

export const CHAPTERS_AHEAD = 2;

// כל מה שנוצר מהתרגום (שמע עברי, תקצירים, שאלות, דוגמת קול) — בנתיב של דור התרגום (trSuffix), כדי ש"תרגם מחדש" יתחיל נקי
const P = {
  lock: (id: string) => `books/${id}/prep.lock.json`,
  // קטע שנכשל בהכנה ברקע: לא מנסים אותו שוב שעה (שם ייחודי לכל כישלון — רשימת הקבצים תמיד טרייה).
  // בלי זה, כישלון קבוע (למשל גוגל שמסרב) חזר על עצמו כל דקה, כל הלילה, ועלה כסף.
  failDir: (id: string) => `books/${id}/prepfail/`,
  audioDir: (book: Book, voice: string, lang: "he" | "en" = "he") => (lang === "en" ? `books/${book.id}/audio/en/${voice}-${KOKORO_VERSION}/` : heAudioDir(book, voice)),
  recap: (book: Book, i: number, voice: string) => `books/${book.id}/recap/${voice}-${TTS_VERSION}${trSuffix(book)}/${i}`,
  questionDir: (book: Book, voice: string) => `books/${book.id}/questions/${voice}-${TTS_VERSION}-p6${trSuffix(book)}/`, // p6 = עם 6 שניות שקט בסוף
  preview: (book: Book, voice: string) => `books/${book.id}/preview/${voice}-${isKokoroVoice(voice) ? KOKORO_VERSION : TTS_VERSION + trSuffix(book)}.mp3`,
};

/** תיקיות השמע והשאלות — לבניית הזרם הרציף. */
export const audioDirFor = (book: Book, voice: string, lang: "he" | "en") => P.audioDir(book, voice, lang);
export const questionDirFor = (book: Book, voice: string) => P.questionDir(book, voice);

/** שפת השמע בפועל: "he" או (במצב מקור, בספר שאינו עברי) "en". */
export function audioLang(book: Book, lang: "he" | "orig" | undefined): "he" | "en" {
  return lang === "orig" && book.lang !== "he" ? "en" : "he";
}

/** קובץ השמע של כל קטע. בעברית עם ניקוד (book.nqFrom): קטעים מ-nqFrom והלאה רק מהתיקייה המנוקדת,
 *  והקודמים רק מהרגילה — כך שזרם שהוגדר עם סימון מסוים תמיד מקבל את אותם קבצים. */
export async function audioFilesFor(book: Book, voice: string, lang: "he" | "en"): Promise<Map<number, store.FileInfo>> {
  const nqFrom = lang === "he" ? book.nqFrom : undefined;
  const dirs = [P.audioDir(book, voice, lang), ...(nqFrom != null ? [heAudioDir(book, voice, true)] : [])];
  const lists = await Promise.all(dirs.map((d) => store.listFiles(d)));
  const out = new Map<number, store.FileInfo>();
  lists.forEach((files, k) => {
    for (const f of files) {
      const m = f.path.slice(dirs[k].length).match(/^(\d+)\.mp3$/);
      if (!m) continue;
      const i = Number(m[1]);
      if (nqFrom != null && (k === 1) !== i >= nqFrom) continue;
      out.set(i, f);
    }
  });
  // קטעים שהוקלטו מחדש בודדים (רק אלה שהזרם הזה מכיר — ראו applyGen)
  const fixes = lang === "he" ? Object.entries(book.fixes ?? {}) : [];
  if (fixes.length) {
    const dir = heFixDir(book, voice);
    const byName = new Map((await store.listFiles(dir)).map((f) => [f.path.slice(dir.length), f]));
    for (const [i, ts] of fixes) {
      const f = byName.get(`${i}-${ts}.mp3`);
      if (f) out.set(Number(i), f);
    }
  }
  return out;
}

/** אילו קטעים כבר יש להם שמע בשפה הזו ובקול הזה. */
export async function readyMap(book: Book, voice: string, lang: "he" | "en" = "he"): Promise<number[]> {
  return [...(await audioFilesFor(book, voice, lang)).keys()].sort((a, b) => a - b);
}

/** טווח ההכנה. עברית (גוגל, עולה כסף): מהקטע הנוכחי עד סוף הפרק (current + CHAPTERS_AHEAD).
 *  אנגלית (Kokoro, כמעט חינם אבל איטי): מהקטע הנוכחי עד סוף הספר. */
export function targetRange(book: Book, section: number, lang: "he" | "en" = "he"): [number, number] {
  const sec = book.sections[Math.min(section, book.sections.length - 1)];
  if (!sec) return [0, -1];
  if (lang === "en") return [section, book.sections.length - 1];
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
  lang: "he" | "en";
  error?: string; // למה ההכנה נעצרה (למשל: גוגל מסרב להקריא את המקור)
}

export async function prepare(id: string, opts: { voice?: string; budgetMs?: number; from?: number; lang?: "he" | "orig" } = {}): Promise<PrepResult> {
  const book = await getBook(id);
  if (!book) throw new Error("אין ספר כזה");
  const progress = await getProgress(id);
  const from = opts.from ?? progress.section;
  // מכינים בשפה שהמאזין בחר: אם הוא במצב "מקור" — שמע באנגלית (Kokoro), ולא מתרגמים לעברית בכלל
  const lang = audioLang(book, opts.lang ?? progress.lang);
  const voice = lang === "en" ? (isKokoroVoice(opts.voice) ? opts.voice : progress.voiceEn || KOKORO_DEFAULT) : (!isKokoroVoice(opts.voice) && opts.voice) || progress.voice || VOICE;
  let ready = await readyMap(book, voice, lang);
  // כלום לא נוצר לפני ▶ הראשון בספר
  if (!progress.startedAt) return { ready, range: [from, from - 1], total: book.sections.length, busy: false, generated: 0, lang };
  const range = targetRange(book, from, lang);
  const readySet = new Set(ready);
  const recentFail = await recentFailures(id);
  const todo: number[] = [];
  for (let i = range[0]; i <= range[1]; i++) if (!readySet.has(i) && !recentFail.has(i)) todo.push(i);
  if (!book.background && book.lang !== "other") {
    // כרטיס רקע לשיחה — פעם אחת לספר, כדי שהשיחה הראשונה לא תחכה לו
    const { ensureBackground } = await import("./conversation");
    await ensureBackground(book).catch((e) => console.warn("background:", (e as Error).message));
  }
  if (!todo.length || book.lang === "other") {
    if (lang === "he") await mergeHeMap(book, ready);
    return { ready, range, total: book.sections.length, busy: false, generated: 0, lang };
  }

  // נעילה: אם מישהו אחר מכין עכשיו — לא מתחילים במקביל
  const lock = await store.readJSON<{ until: string }>(P.lock(id));
  if (lock && new Date(lock.until).getTime() > Date.now()) return { ready, range, total: book.sections.length, busy: true, generated: 0, lang };

  const budget = opts.budgetMs ?? 240_000;
  const start = Date.now();
  const setLock = () => store.writeJSON(P.lock(id), { until: new Date(Date.now() + 400_000).toISOString() }); // קטע אנגלי ב-Kokoro לוקח עד ~4 דקות
  await setLock();
  let generated = 0;
  let failed = 0;
  let error: string | undefined;
  let ahead: Promise<void> | null = null; // ההכנה מראש של הקטע הבא — מחכים לה לפני שמשחררים את הנעילה (אחרת ריצה אחרת תנקד שוב)
  try {
    for (const [k, i] of todo.entries()) {
      if (Date.now() - start > budget) break;
      try {
        const audio = ensureAudio(book, i, lang === "he" ? "he" : "orig", voice);
        // עברית: התרגום והניקוד של הקטע הבא רצים בזמן שהקול של הקטע הזה נוצר (התרגום שלו כבר נרשם — הבא יחכה לו)
        if (lang === "he" && todo[k + 1] != null) ahead = prefetchSpokenText(book, todo[k + 1]);
        await audio;
        generated++;
        failed = 0;
        readySet.add(i);
      } catch (e) {
        // קטע שנכשל לא עוצר את כולם — אבל שני כישלונות ברצף כן (כנראה בעיה כללית, לא נקודתית)
        failed++;
        error = (e as Error).message;
        console.warn(`prepare ${id} section ${i} (${lang}):`, error);
        await store.writeJSON(`${P.failDir(id)}${i}-${Date.now()}.json`, { lang, error }).catch(() => {});
        if (failed >= 2) break;
      }
      await setLock();
    }
  } finally {
    if (ahead) await Promise.race([ahead, new Promise((r) => setTimeout(r, 90_000))]);
    await store.remove(P.lock(id));
  }
  ready = [...readySet].sort((a, b) => a - b);
  if (lang === "he") {
    await mergeHeMap(book, ready);
    // שאלות סוף פרק לפרקים שכבר מוכנים כולם בטווח — כדי שייכנסו לזרם הרציף בלי המתנה
    if (progress.study !== false && Date.now() - start < budget) {
      const qDir = questionDirFor(book, voice);
      const have = new Set((await store.listPaths(qDir)).map((p) => p.slice(qDir.length)));
      for (let c = book.sections[range[0]]?.chapter ?? 0; c < book.chapters.length; c++) {
        const ch = book.chapters[c];
        if (ch.end > range[1]) break;
        let all = true;
        for (let i = ch.start; i <= ch.end; i++) if (!readySet.has(i)) all = false;
        if (!all || have.has(`${c}.mp3`) || c === book.chapters.length - 1) continue;
        if (Date.now() - start > budget) break;
        await chapterQuestion(book, c, voice).catch((e) => console.warn("question", c, (e as Error).message));
      }
    }
  }
  return { ready, range, total: book.sections.length, busy: false, generated, lang, error };
}

const FAIL_BACKOFF_MS = 60 * 60 * 1000;
/** קטעים שנכשלו בהכנה ברקע בשעה האחרונה — לא מנסים אותם שוב עכשיו (האזנה עצמה עדיין יכולה לבקש אותם). */
async function recentFailures(id: string): Promise<Set<number>> {
  const dir = P.failDir(id);
  const out = new Set<number>();
  for (const path of await store.listPaths(dir).catch(() => [] as string[])) {
    const m = path.slice(dir.length).match(/^(\d+)-(\d+)\.json$/);
    if (m && Date.now() - Number(m[2]) < FAIL_BACKOFF_MS) out.add(Number(m[1]));
  }
  return out;
}

/** מפת התרגומים לתצוגה (קובץ אחד במקום מאות קריאות). */
export async function readHeMap(book: Book): Promise<Record<number, string>> {
  if (book.lang === "he") return Object.fromEntries(book.sections.map((s) => [s.i, s.text]));
  return (await store.readJSON<Record<number, string>>(heMapPath(book))) ?? {};
}

async function mergeHeMap(book: Book, ready: number[]) {
  if (book.lang === "he") return;
  // קוראים רק תרגומים שבאמת קיימים (רשימה אחת), ולא מנחשים מאות קבצים חסרים
  const dir = heDir(book);
  const existing = new Set(
    (await store.listPaths(dir))
      .map((p) => p.slice(dir.length).match(/^(\d+)\.txt$/)?.[1])
      .filter((x): x is string => !!x)
      .map(Number),
  );
  if (!existing.size) return;
  const map = (await store.readJSON<Record<number, string>>(heMapPath(book))) ?? {};
  // קודם מה שמוכן לשמע, אחר כך כל השאר — עד 120 בכל סיבוב
  const readySet = new Set(ready);
  const order = [...ready, ...book.sections.map((s) => s.i).filter((i) => !readySet.has(i))];
  const missing = order.filter((i) => existing.has(i) && !map[i]).slice(0, 120);
  if (!missing.length) return;
  const texts = await Promise.all(missing.map((i) => store.readText(heTextPath(book, i))));
  let added = 0;
  missing.forEach((i, k) => {
    if (texts[k]) {
      map[i] = texts[k]!;
      added++;
    }
  });
  if (added) await store.writeJSON(heMapPath(book), map);
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
  const texts = await Promise.all(missing.slice(0, 40).map((i) => store.readText(heTextPath(book, i))));
  missing.slice(0, 40).forEach((i, k) => {
    if (texts[k]) out[i] = texts[k]!;
  });
  return out;
}

export async function speak(text: string, voice: string, pathNoExt: string, trailingSilenceSec = 0): Promise<string> {
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
  const base = P.recap(book, upto, voice);
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
  const base = `${P.questionDir(book, voice)}${c}`;
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
  const p = P.preview(book, voice);
  const existing = await store.exists(p);
  if (existing) return existing;
  const i = Math.min(1, book.sections.length - 1);
  if (isKokoroVoice(voice)) {
    // דוגמה באנגלית, מהמקור
    const text = book.sections[i].text.slice(0, 360);
    const { pcm } = await (await import("./kokoro")).kokoroTts(text, voice);
    return store.writeBytes(p, await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
  }
  const text = (book.lang === "he" ? book.sections[i].text : await ensureTranslation(book, i)).slice(0, 420);
  const pcm = await tts(text, "he", voice);
  return store.writeBytes(p, await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
}
