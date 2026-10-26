// זרם רציף: כל הקטעים המוכנים (ושאלות סוף פרק במקומן) כקובץ MP3 אחד ארוך — כדי שהטלפון ינגן שעה
// בלי "סוף שיר" כל שתי דקות (הרגע שבו אנדרואיד מקפיא את הדף כשהמסך כבוי).
// ה-MP3 בקצב קבוע (48kbps) ולכן משך = גודל / 6000, וזה מה שמאפשר למפות זמן ↔ קטע ולהגיש Range.
import * as store from "./storage";
import type { Book } from "./books";
import { audioDirFor, questionDirFor } from "./prepare";

export const BYTES_PER_SEC = 6000; // 48kbps CBR
const MAX_SECONDS = 4 * 3600;

export interface StreamItem {
  kind: "section" | "question";
  i: number; // מספר קטע, או מספר פרק לשאלה
  chapter: number;
  bytes: number;
  start: number; // שניות מתחילת הזרם
  seconds: number;
}

export interface Manifest {
  from: number;
  upto: number;
  qs: number[]; // פרקים שהשאלה שלהם כלולה
  lang: "he" | "en";
  voice: string;
  gen?: string; // דור התרגום — כדי שהזרם יישאר בדיוק אותו זרם גם אם בינתיים לחצו "תרגם מחדש"
  items: StreamItem[];
  totalSeconds: number;
  totalBytes: number;
}

async function files(book: Book, voice: string, lang: "he" | "en") {
  const aDir = audioDirFor(book, voice, lang);
  const qDir = questionDirFor(book, voice);
  const [a, q] = await Promise.all([store.listFiles(aDir), lang === "he" ? store.listFiles(qDir) : Promise.resolve([] as store.FileInfo[])]);
  const sections = new Map<number, store.FileInfo>();
  for (const f of a) {
    const m = f.path.slice(aDir.length).match(/^(\d+)\.mp3$/);
    if (m) sections.set(Number(m[1]), f);
  }
  const questions = new Map<number, store.FileInfo>();
  for (const f of q) {
    const m = f.path.slice(qDir.length).match(/^(\d+)\.mp3$/);
    if (m) questions.set(Number(m[1]), f);
  }
  return { sections, questions };
}

/** מה אפשר להשמיע ברצף מהקטע הזה: עד הקטע הראשון שעוד לא מוכן (או 4 שעות). */
export async function buildManifest(book: Book, from: number, lang: "he" | "en", voice: string, study: boolean, fixed?: { upto: number; qs: number[] }, maxSeconds = MAX_SECONDS): Promise<Manifest> {
  const { sections, questions } = await files(book, voice, lang);
  const items: StreamItem[] = [];
  const qs: number[] = [];
  let t = 0;
  let bytes = 0;
  let upto = from - 1;
  const last = fixed ? Math.min(fixed.upto, book.sections.length - 1) : book.sections.length - 1;
  const fixedQs = fixed ? new Set(fixed.qs) : null;
  for (let i = from; i <= last; i++) {
    const f = sections.get(i);
    if (!f || t > maxSeconds) break;
    const c = book.sections[i].chapter;
    items.push({ kind: "section", i, chapter: c, bytes: f.size, start: t, seconds: f.size / BYTES_PER_SEC });
    t += f.size / BYTES_PER_SEC;
    bytes += f.size;
    upto = i;
    const q = questions.get(c);
    const wantQ = fixedQs ? fixedQs.has(c) : study && lang === "he" && i + 1 < book.sections.length;
    if (wantQ && book.chapters[c]?.end === i && q) {
      items.push({ kind: "question", i: c, chapter: c, bytes: q.size, start: t, seconds: q.size / BYTES_PER_SEC });
      t += q.size / BYTES_PER_SEC;
      bytes += q.size;
      qs.push(c);
    }
  }
  return { from, upto, qs, lang, voice, gen: lang === "he" ? book.trGen : undefined, items, totalSeconds: t, totalBytes: bytes };
}

/** אותו זרם בדיוק כפי שהוגדר בכתובת (from/upto/qs) — יציב גם אם בינתיים הוכנו עוד קטעים. */
export async function resolveStream(book: Book, from: number, upto: number, qs: number[], lang: "he" | "en", voice: string) {
  const { sections, questions } = await files(book, voice, lang);
  const parts: { info: store.FileInfo; offset: number }[] = [];
  let offset = 0;
  const qset = new Set(qs);
  for (let i = from; i <= upto; i++) {
    const f = sections.get(i);
    if (!f) throw new Error(`קטע ${i} חסר בזרם`);
    parts.push({ info: f, offset });
    offset += f.size;
    const c = book.sections[i]?.chapter;
    if (qset.has(c) && book.chapters[c]?.end === i) {
      const q = questions.get(c);
      if (!q) throw new Error(`שאלה לפרק ${c} חסרה בזרם`);
      parts.push({ info: q, offset });
      offset += q.size;
    }
  }
  return { parts, total: offset };
}

/** גוף התשובה לטווח בייטים [start, end] מתוך הזרם. */
export function rangeStream(parts: { info: store.FileInfo; offset: number }[], start: number, end: number): ReadableStream<Uint8Array> {
  let k = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (k < parts.length) {
        const p = parts[k++];
        const pStart = p.offset;
        const pEnd = p.offset + p.info.size - 1;
        if (pEnd < start || pStart > end) continue;
        const s = Math.max(start, pStart) - pStart;
        const e = Math.min(end, pEnd) - pStart;
        const buf = await store.readRange(p.info, s, e);
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return;
      }
      controller.close();
    },
  });
}
