// השיחה על הספר: כרטיס רקע (פעם אחת לספר), הוראות למודל החי (שיחה פתוחה, בלי הגבלת ספוילרים),
// "לחשוב לעומק" (המודל החי מעביר את השאלה למוח הגדול), ופתקים — ידניים ("תשמור את זה") וסיכום אוטומטי בסוף שיחה.
import crypto from "crypto";
import * as store from "./storage";
import { getBook, saveBook, type Book } from "./books";
import { genDeep, createLiveToken, VOICE, type LiveTool } from "./gemini";
import { heTexts } from "./prepare";

export interface Note {
  id: string;
  at: string; // ISO
  section: number;
  chapter: string;
  kind: "saved" | "summary"; // "תשמור את זה" / סיכום אוטומטי של שיחה
  title: string;
  text: string;
}

export interface Turn {
  role: "user" | "model";
  text: string;
}

const P = {
  notes: (id: string) => `books/${id}/notes.json`,
};

const bookLabel = (book: Book) => `"${book.title}"${book.author ? ` מאת ${book.author}` : ""}`;

// ---------- כרטיס רקע ----------

/** נוצר פעם אחת לספר על ידי המוח הגדול: מי המחבר, מתי ולמה נכתב, רעיונות מרכזיים, התקבלות, למה חשוב היום. */
export async function ensureBackground(book: Book): Promise<string> {
  if (book.background) return book.background;
  const sample = book.sections.slice(0, 5).map((s) => s.text).join("\n\n").slice(0, 9000);
  const sys = "כתוב בעברית פשוטה וברורה, בלי ניקוד, בלי כותרות ובלי סימני עיצוב. פסקאות קצרות. אם אינך בטוח בפרט — אמור שאינך בטוח, אל תמציא.";
  const prompt =
    `כתוב כרטיס רקע של 200-300 מילים על הספר ${bookLabel(book)}, בשביל בן שיחה שידבר עליו עם מאזין. ` +
    "כלול: מי המחבר ומה חשוב לדעת עליו; מתי ובאיזה הקשר היסטורי ואישי נכתב; הרעיונות או הנושאים המרכזיים; מבנה הספר בקצרה; " +
    "איך התקבל ואיזו השפעה הייתה לו; עם אילו הוגים או יצירות הוא מתכתב; ולמה הוא מעניין קורא היום.\n\n" +
    `תחילת הטקסט, לזיהוי:\n${sample}`;
  const background = await genDeep(prompt, sys, 2048);
  const fresh = await getBook(book.id);
  if (fresh) {
    fresh.background = background;
    await saveBook(fresh);
  }
  book.background = background;
  return background;
}

// ---------- מה נשמע עד עכשיו ----------

async function heardSoFar(book: Book, section: number) {
  const sec = book.sections[Math.min(section, book.sections.length - 1)];
  const ch = sec ? book.chapters[sec.chapter] : undefined;
  const from = ch ? ch.start : 0;
  const idx = Array.from({ length: Math.max(0, section - from + 1) }, (_, k) => from + k);
  const he = await heTexts(book, idx);
  let body = idx.map((i) => he[i] ?? book.sections[i]?.text ?? "").join("\n\n");
  if (body.length > 24000) body = "…" + body.slice(-24000);
  const current = he[section] ?? sec?.text ?? "";
  const chapterNo = sec ? sec.chapter + 1 : 1;
  const toc = book.chapters.map((c, k) => `${k + 1}. ${c.title}`).join("\n").slice(0, 3000);
  return { body, current, chapter: ch?.title ?? "", chapterNo, toc };
}

// ---------- המודל החי ----------

const TOOLS: LiveTool[] = [
  {
    name: "deep_think",
    description:
      "מעביר את השאלה או הטענה של המאזין למומחה חושב (מודל גדול ואיטי יותר) ומחזיר תשובה מנומקת. " +
      "קרא לזה כשמצב 'לחשוב לעומק' פועל (תקבל על כך הודעת מערכת), או כשהמאזין מבקש במפורש לחשוב לעומק / לבדוק טוב / תשובה רצינית. " +
      "אחרי שהתשובה חוזרת — הקרא אותה למאזין כפי שהיא, בלי לקצר ובלי להוסיף הקדמה.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "השאלה או הטענה של המאזין, במילים שלו, כולל ההקשר הדרוש כדי להבין אותה לבד" },
      },
      required: ["question"],
    },
  },
  {
    name: "save_note",
    description:
      "שומר פתק לספר הזה. קרא לזה כשהמאזין אומר 'תשמור את זה', 'תרשום לי', 'פתק' או כשהוא לוחץ על כפתור הפתק (תקבל הודעת מערכת). " +
      "הפתק הוא תמצית של מה שדיברתם עליו ממש עכשיו: הרעיון, הניסוח שהמאזין הגיע אליו, שאלות שנשארו פתוחות. אחרי השמירה אמור משפט אחד קצר שהפתק נשמר.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "כותרת של 3-7 מילים" },
        text: { type: "string", description: "גוף הפתק: 40-150 מילים, עברית פשוטה, בלי ניקוד ובלי עיצוב" },
      },
      required: ["title", "text"],
    },
  },
];

/** הוראות למודל החי — "חברותא": שיחה פתוחה וכנה, ידע עולם חופשי, בלי הגבלת ספוילרים. */
export async function liveSession(book: Book, section: number, voice = VOICE) {
  const [background, heard] = await Promise.all([ensureBackground(book).catch(() => book.summary ?? ""), heardSoFar(book, section)]);
  const system =
    `אתה בן שיחה חכם ובקיא, שלומד איתי את הספר ${bookLabel(book)}. יש לך רקע על הספר (למטה) ועל מה ששמעתי עד עכשיו (למטה). ` +
    "דבר איתי כמו חבר למחשבה: כנה, ישיר, לא מתחנף. כשאני מעלה רעיון — תגיב לרעיון, תחדד, תתווכח אם צריך, תביא מקבילות מהוגים אחרים ומהעולם. " +
    "כשאני שואל על המחבר, התקופה או מושג — ענה מהידע שלך בלי הסתייגויות. אל תגביל את עצמך למה ששמעתי: אם ההמשך של הספר רלוונטי לשאלה, ספר. " +
    "דבר עברית טבעית ומדוברת, בלי ניקוד, בלי רשימות. קצר כשאני נוהג (שניים-ארבעה משפטים), ארוך כשאני מבקש להעמיק. " +
    "אם אני אומר 'תשמור את זה' או 'תרשום לי' — שמור פתק עם תמצית מה שאמרנו (save_note). " +
    "כשמצב 'לחשוב לעומק' פועל (תקבל הודעת מערכת), כל שאלה או טענה שלי עוברת למומחה דרך deep_think, ואתה מקריא את תשובתו כפי שהיא. " +
    "כשאני אומר שסיימתי — היפרד במשפט אחד.\n\n" +
    `רקע על הספר:\n${background}\n\n` +
    `תוכן העניינים:\n${heard.toc}\n\n` +
    `אני נמצא בפרק ${heard.chapterNo} מתוך ${book.chapters.length}: "${heard.chapter}".\n\n` +
    `הקטע שנשמע ממש עכשיו:\n${heard.current}\n\n` +
    `כל מה שנשמע בפרק הזה עד עכשיו:\n${heard.body}`;
  return createLiveToken(system, voice, TOOLS);
}

// ---------- המוח הגדול ----------

function transcriptText(transcript: Turn[], max = 12000) {
  const t = transcript.map((x) => `${x.role === "user" ? "אני" : "בן השיחה"}: ${x.text}`).join("\n");
  return t.length > max ? "…" + t.slice(-max) : t;
}

/** תשובה מנומקת לשאלת עומק — Pro עם חשיבה גבוהה, מנוסחת להקראה. */
export async function deepAnswer(book: Book, section: number, question: string, transcript: Turn[]): Promise<string> {
  const [background, heard] = await Promise.all([ensureBackground(book).catch(() => book.summary ?? ""), heardSoFar(book, section)]);
  const sys =
    "אתה הוגה ובן שיחה בקיא ועמוק, שמדבר עם אדם שלומד ספר ברכב. התשובה שלך תוקרא בקול, לכן: עברית מדוברת וטבעית, בלי ניקוד, בלי כותרות, בלי רשימות, בלי סימני עיצוב. " +
    "ענה לעניין ובעומק: טיעון ברור, דוגמה אחת טובה, מקבילה מהוגה או יצירה אחרת כשזה מאיר משהו, ומה אתה חושב באמת — גם אם זה חולק על המאזין או על המחבר. " +
    "אל תפתח בהקדמה ואל תסכם בסוף. 80 עד 170 מילים — הוא נוהג; אם הוא ביקש במפורש להרחיב, עד 300.";
  const prompt =
    `הספר: ${bookLabel(book)}.\n\nרקע:\n${background}\n\n` +
    `המאזין נמצא בפרק ${heard.chapterNo} ("${heard.chapter}"). מה שנשמע בפרק עד עכשיו:\n${heard.body.slice(-9000)}\n\n` +
    (transcript.length ? `השיחה עד כה:\n${transcriptText(transcript, 6000)}\n\n` : "") +
    `השאלה או הטענה של המאזין עכשיו:\n${question}\n\nהתשובה:`;
  return genDeep(prompt, sys, 4096, "MEDIUM");
}

// ---------- פתקים ----------

export async function listNotes(bookId: string): Promise<Note[]> {
  return (await store.readJSON<Note[]>(P.notes(bookId))) ?? [];
}

export async function addNote(book: Book, n: Omit<Note, "id" | "at" | "chapter">): Promise<Note> {
  const sec = book.sections[Math.min(n.section, book.sections.length - 1)];
  const chapter = sec ? book.chapters[sec.chapter]?.title ?? "" : "";
  const note: Note = { id: crypto.randomBytes(5).toString("hex"), at: new Date().toISOString(), chapter, ...n };
  const notes = await listNotes(book.id);
  notes.unshift(note);
  await store.writeJSON(P.notes(book.id), notes);
  return note;
}

export async function deleteNote(bookId: string, noteId: string): Promise<void> {
  const notes = await listNotes(bookId);
  await store.writeJSON(P.notes(bookId), notes.filter((n) => n.id !== noteId));
}

/** סיכום אוטומטי של שיחה (בסוף השיחה) — נשמר כפתק. מחזיר null אם לא היה על מה לסכם. */
export async function summarizeConversation(book: Book, section: number, transcript: Turn[]): Promise<Note | null> {
  const meaningful = transcript.filter((t) => t.text.trim().length > 15);
  if (meaningful.filter((t) => t.role === "user").length < 2) return null;
  const sys = "כתוב בעברית פשוטה, בלי ניקוד ובלי סימני עיצוב (בלי כוכביות, בלי סולמיות). השורה הראשונה היא הכותרת בלבד (3-7 מילים), אחריה שורה ריקה, ואחריה גוף הפתק.";
  const prompt =
    `זו שיחה בין מאזין לבן שיחה על הספר ${bookLabel(book)}. כתוב פתק סיכום בשביל המאזין: ` +
    "כותרת של 3-7 מילים; וגוף של 80-200 מילים עם: הנושאים שעלו, הרעיונות או הניסוחים שהמאזין הגיע אליהם, תובנות של בן השיחה ששווה לזכור, ושאלות שנשארו פתוחות. " +
    "כתוב בגוף שני ('דיברת על…'), בלי להמציא דברים שלא נאמרו.\n\n" +
    `השיחה:\n${transcriptText(transcript)}\n\nהפתק:`;
  const raw = (await genDeep(prompt, sys, 2048)).replace(/[*#_`]+/g, "").trim();
  const lines = raw.split("\n").map((l) => l.trim());
  const firstIdx = lines.findIndex((l) => l.length > 0);
  let title = "סיכום שיחה";
  let text = raw;
  if (firstIdx >= 0 && lines[firstIdx].length <= 80) {
    title = lines[firstIdx].replace(/^כותרת[:\s]*/, "");
    text = lines.slice(firstIdx + 1).join("\n").trim() || raw;
  }
  return addNote(book, { section, kind: "summary", title, text });
}
