// כרטיס תרגום: לכל ספר שאינו בעברית — מחקר (המודל הגדול + חיפוש בגוגל) על התרגומים העבריים שלו:
// מי תרגם, איזה תרגום נחשב הטוב, ומה שיטת המתרגם. מזה נבנים הנחיות ומילון קבוע (שמות, ביטויים חוזרים)
// שהמתרגם שלנו עובד לפיהם — חיקוי של סגנון וגישה, לא העתקה של טקסט.
// כל גרסה של הכרטיס נשמרת כקובץ נפרד (האחרונה קובעת), וגם כל ניסיון מחקר מסומן בקבצים נפרדים —
// כי Blob מחזיר לזמן מה גרסה ישנה של קובץ שנדרס.
import * as store from "./storage";
import type { Book } from "./books";
import { researchWithSearch, genJson, usageCostUsd, MOCK, MODELS, type Usage } from "./gemini";
import { cleanSectionText } from "./text";

export interface Translation {
  translator: string;
  year?: string;
  publisher?: string;
  notes?: string;
}

export interface GlossaryEntry {
  en: string; // הצורה במקור, כמו שהיא מופיעה בטקסט
  he: string;
  note?: string; // "לפי התרגום של X" / "הצעה"
}

export interface TranslationCard {
  id: string; // חותמת זמן — גם שם הקובץ
  createdAt: string;
  source: "research" | "edit";
  hebrewTitle?: string;
  translations: Translation[];
  model?: string; // איזה תרגום אנחנו מחקים, ולמה
  approach: string; // שיטת התרגום — בשפה פשוטה, לתצוגה
  instructions: string; // ההנחיות למתרגם שלנו, שורה לכל הנחיה
  glossary: GlossaryEntry[];
  confidence: "high" | "medium" | "low";
  sources: { title: string; url: string }[];
  report?: string; // דוח המחקר המלא
  cost?: { usd: number; searches: number }; // מה המחקר עלה בפועל (טוקנים; חיפושים — 5,000 בחודש בחינם)
}

export type CardStatus =
  | { state: "none" }
  | { state: "researching"; startedAt: string }
  | { state: "error"; at: string; error: string }
  | { state: "ready" };

const D = {
  cards: (id: string) => `books/${id}/tcard/`,
  runs: (id: string) => `books/${id}/tcard-run/`,
};
const RUN_STALE_MS = 6 * 60 * 1000; // ניסיון מחקר שלא נגמר אחרי 6 דקות — נחשב תקוע
const RETRY_AFTER_ERROR_MS = 60 * 60 * 1000; // אחרי כישלון — לא מנסים שוב לבד שעה (ידנית אפשר תמיד)

const numericIds = (paths: string[], dir: string, re: RegExp) =>
  paths
    .map((p) => p.slice(dir.length).match(re))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1]);

/** הגרסה האחרונה של הכרטיס. */
export async function latestCard(bookId: string): Promise<TranslationCard | null> {
  const dir = D.cards(bookId);
  const ids = numericIds(await store.listPaths(dir), dir, /^(\d+)\.json$/).sort((a, b) => Number(b) - Number(a));
  for (const id of ids.slice(0, 3)) {
    const c = await store.readJSON<TranslationCard>(`${dir}${id}.json`);
    if (c) return c;
  }
  return null;
}

async function saveCard(bookId: string, card: Omit<TranslationCard, "id" | "createdAt">, now = Date.now()): Promise<TranslationCard> {
  const full: TranslationCard = { ...card, id: String(now), createdAt: new Date(now).toISOString() };
  await store.writeJSON(`${D.cards(bookId)}${full.id}.json`, full);
  return full;
}

/** מצב המחקר: האם רץ עכשיו, האם נכשל לאחרונה. */
export async function cardStatus(bookId: string, now = Date.now()): Promise<CardStatus & { card: TranslationCard | null }> {
  const card = await latestCard(bookId);
  const dir = D.runs(bookId);
  const paths = await store.listPaths(dir);
  const runs = new Map<string, Set<string>>();
  for (const p of paths) {
    const m = p.slice(dir.length).match(/^(\d+)\.(start|done|fail)\.json$/);
    if (!m) continue;
    if (!runs.has(m[1])) runs.set(m[1], new Set());
    runs.get(m[1])!.add(m[2]);
  }
  const last = [...runs.keys()].filter((k) => runs.get(k)!.has("start")).sort((a, b) => Number(b) - Number(a))[0];
  if (last) {
    const kinds = runs.get(last)!;
    const startedAt = Number(last);
    // מחקר שרץ עכשיו (גם אם כבר יש כרטיס — "חקור מחדש")
    if (!kinds.has("done") && !kinds.has("fail") && now - startedAt < RUN_STALE_MS) return { state: "researching", startedAt: new Date(startedAt).toISOString(), card };
    if (kinds.has("fail") && (!card || Number(card.id) < startedAt)) {
      const f = await store.readJSON<{ at: string; error: string }>(`${dir}${last}.fail.json`);
      return { state: "error", at: f?.at ?? new Date(startedAt).toISOString(), error: f?.error ?? "המחקר נכשל", card };
    }
  }
  return card ? { state: "ready", card } : { state: "none", card };
}

// ---------- מה יש בספר: שמות חוזרים ודוגמת סגנון ----------

const STOP = new Set(
  (
    "I Mr Mrs Ms Dr Miss Sir Madam God Lord Jesus Christ OK Okay Oh Ah Yes No Well Then Now Chapter Book Part " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December " +
    "English French German American Christmas"
  ).split(" "),
);

/** שמות ומונחים שחוזרים בספר: מילים באות גדולה באמצע משפט (ולא בתחילתו), שכמעט לא מופיעות באות קטנה. */
export function candidateNames(texts: string[], max = 50): { name: string; count: number }[] {
  const cap = new Map<string, number>();
  const lower = new Map<string, number>();
  const multi = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const raw of texts) {
    const t = raw.replace(/[’]/g, "'").replace(/[ \t\u00a0]+/g, " "); // טקסט מ-PDF מגיע לפעמים עם רווחים כפולים
    // מילים בודדות
    for (const m of t.matchAll(/([A-Za-z][a-z]+)(?:'s)?/g)) {
      const w = m[1];
      const idx = m.index ?? 0;
      if (w[0] === w[0].toLowerCase()) {
        inc(lower, w);
        continue;
      }
      // מה לפני המילה: אם זה סוף משפט / תחילת פסקה / פתיחת ציטוט — האות הגדולה לא אומרת כלום
      const before = t.slice(Math.max(0, idx - 3), idx);
      if (idx === 0 || /(^|[.!?:;"“”(\n—-])\s*$/.test(before) || /\n\s*$/.test(before)) continue;
      inc(cap, w);
    }
    // צירופים: "Mr. Antolini", "Central Park", "Jane Gallagher"
    for (const m of t.matchAll(/\b((?:Mr|Mrs|Ms|Dr)\.? [A-Z][a-z]+|[A-Z][a-z]+ (?:[A-Z][a-z]+ )?[A-Z][a-z]+)\b/g)) {
      const words = m[1].split(" ");
      if (words.some((w) => STOP.has(w.replace(/\.$/, "")) && !/^(Mr|Mrs|Ms|Dr)\.?$/.test(w))) continue;
      inc(multi, m[1]);
    }
    // ראשי תיבות: "D.B."
    for (const m of t.matchAll(/\b((?:[A-Z]\.){2,})/g)) inc(multi, m[1]);
  }
  const out: { name: string; count: number }[] = [];
  const multiNames: [string, number][] = [];
  for (const [w, n] of multi) {
    if (n < 2) continue;
    // צירוף שכל המילים שלו רגילות ("The End") — לא שם
    const parts = w.split(" ").filter((p) => !/^(Mr|Mrs|Ms|Dr)\.?$/.test(p));
    if (parts.every((p) => (lower.get(p.toLowerCase()) ?? 0) > (cap.get(p) ?? 0))) continue;
    multiNames.push([w, n]);
    out.push({ name: w, count: n });
  }
  for (const [w, n] of cap) {
    if (n < 3 || STOP.has(w)) continue;
    const lo = lower.get(w.toLowerCase()) ?? 0;
    if (lo > n * 0.25) continue; // מילה רגילה שבמקרה באה באות גדולה
    // חלק משם מורכב ("York" מתוך "New York", "Avenue" מתוך "Fifth Avenue") — השם המלא כבר ברשימה
    const inMulti = multiNames.reduce((sum, [m, c]) => sum + (m.split(" ").includes(w) ? c : 0), 0);
    if (inMulti >= n * 0.6) continue;
    out.push({ name: w, count: n });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, max);
}

/** קטעים מכמה מקומות בספר (התחלה, אמצע, שלושה רבעים) — לזיהוי הקול, הסגנון והביטויים החוזרים של המספר. */
export function styleSample(book: Book, chars = 4800): string {
  const secs = book.sections.filter((s) => s.text.length >= 200); // בלי עמודי שער ו"פרק 1"
  if (!secs.length) return book.sections.map((s) => s.text).join("\n\n").slice(0, chars);
  const at = [0, Math.floor(secs.length / 2), Math.floor((secs.length * 3) / 4)].filter((v, k, a) => a.indexOf(v) === k);
  const per = Math.floor(chars / at.length);
  return at
    .map((k) => {
      let t = "";
      for (let j = k; j < secs.length && t.length < per; j++) t += (t ? "\n\n" : "") + cleanSectionText(book, secs[j].i);
      return t.slice(0, per);
    })
    .join("\n\n[…]\n\n");
}

// ---------- המחקר ----------

const bookLabel = (book: Book) => `"${book.title}"${book.author ? ` מאת ${book.author}` : ""}`;

const RESEARCH_SYSTEM =
  "אתה חוקר ספרות ותרגום. ענה בעברית. השתמש בחיפוש כדי לבסס כל עובדה, וחפש גם בעברית וגם בשפת המקור. " +
  "אל תמציא: אם לא מצאת משהו, כתוב במפורש 'לא מצאתי'. אל תצטט קטעים ארוכים מתרגומים — לכל היותר כמה מילים, כדוגמה לבחירה של מתרגם.";

export function researchPrompt(book: Book): string {
  return (
    `הספר: ${bookLabel(book)}.\n` +
    "אנחנו מתרגמים את הספר לעברית בעזרת בינה מלאכותית, בשביל האזנה, ורוצים שהתרגום יישמע כמה שיותר כמו תרגום עברי טוב ומוערך שלו. " +
    "בצע מחקר רציני ודווח לפי הסעיפים:\n" +
    "1. אילו תרגומים לעברית יש לספר: מתרגם, שנה, הוצאה, ושם הספר בעברית.\n" +
    "2. איזה תרגום נחשב הטוב או העדכני ביותר, ולמה (ביקורות, כתבות, דיונים).\n" +
    "3. שיטת התרגום של המתרגם הזה: המשלב הלשוני (גבוה, מדובר, סלנג), איך העביר את הקול של המספר, איך טיפל בקללות ובביטויים החוזרים, " +
    "בשמות ובכינויים, בניבים ובהומור, באורך ובקצב של המשפטים, והאם קירב את הטקסט לעברית ולישראל או שמר על הזרות. " +
    "בחירות ידועות שלו במילים או בביטויים מרכזיים — רק אם מצאת להן מקור.\n" +
    "4. אם אין לספר תרגום לעברית: איך מתרגמים עבריים מובילים תרגמו את המחבר הזה או ספרות דומה, ומה הגישה המומלצת.\n" +
    "5. מאפייני הסגנון של המקור שחשוב לשמר בתרגום: קול, משלב, ביטויים חוזרים, מבנה משפטים.\n" +
    "6. ביקורת על תרגומים קודמים — מה נחשב לא מוצלח, כדי שנימנע מזה.\n" +
    "כתוב דוח מפורט ומסודר לפי הסעיפים, וציין לגבי כל טענה מאיפה היא."
  );
}

const STRUCTURE_SYSTEM =
  "אתה עורך תרגום ספרותי. מתוך דוח מחקר וקטעים מהספר, הכן 'כרטיס תרגום' שמתרגם בינה מלאכותית יעבוד לפיו בכל קטע מהספר. " +
  "המאזין ביקש במפורש שהתרגום יהיה כמה שיותר דומה לתרגום העברי הנבחר — לכן ההנחיות מתארות את השיטה של המתרגם הזה כפי שהיא, " +
  "כולל בחירות שנויות במחלוקת. ביקורת מציינים, אבל לא 'מתקנים' בגללה את השיטה. " +
  "כתוב בעברית (מלבד הצורות במקור שבמילון). אל תמציא עובדות שאינן בדוח: כשאין מקור לבחירה של המתרגם — הצע בחירה ברוח השיטה שלו וסמן אותה כהצעה.";

export function structurePrompt(book: Book, report: string, names: { name: string; count: number }[], sample: string): string {
  return (
    `הספר: ${bookLabel(book)}.\n\n` +
    `דוח המחקר:\n${report.slice(0, 20000)}\n\n` +
    `קטעים מהספר במקור, מכמה מקומות (לזיהוי הקול, הסגנון והביטויים החוזרים):\n${sample}\n\n` +
    `שמות ומונחים שחוזרים בספר (מספר הופעות):\n${names.map((n) => `${n.name} (${n.count})`).join(", ") || "—"}\n\n` +
    "הכן את הכרטיס:\n" +
    "- hebrewTitle: שם הספר בעברית, כפי שתורגם (אם יש).\n" +
    "- translations: התרגומים לעברית שנמצאו בדוח (מתרגם, שנה, הוצאה, הערה קצרה).\n" +
    "- model: איזה תרגום אנחנו מחקים — בדרך כלל העדכני או המוערך ביותר — ולמה, במשפט אחד. אם אין תרגום: 'אין תרגום עברי; הגישה מבוססת על…'.\n" +
    "- approach: 3 עד 5 משפטים פשוטים, למאזין, שמסבירים איך המתרגם הזה עובד. אם יש ביקורת מרכזית על התרגום — משפט אחד שמתאר אותה (בלי לשנות בגללה את ההנחיות).\n" +
    "- instructions: 8 עד 15 הנחיות קונקרטיות שמתארות את השיטה של המתרגם הנבחר כפי שהיא: המשלב, בחירות המילים הידועות שלו (כולל מילות סלנג שהוא משתמש בהן), " +
    "הקול של המספר, קללות, ביטויים חוזרים ואיך לתרגם אותם בעקביות, שמות, ניבים, קצב המשפטים. כל הנחיה במשפט או שניים.\n" +
    "- glossary: מילון קבוע. (א) כל השמות והמקומות מהרשימה שמופיעים 5 פעמים ומעלה (וגם פחות, אם הם חשובים), בכתיב עברי עקבי — כפי שבתרגום הנבחר אם ידוע — ונוח להקראה בקול (ראשי תיבות של שם כמו שהוגים אותם, למשל די־בי); " +
    "(ב) לפחות 10 ביטויים, מילים טעונות וקללות שחוזרים אצל המספר (חפש אותם בקטעים מהספר), עם תרגום עקבי ברוח המתרגם. " +
    "השדה en — בדיוק כפי שהצורה מופיעה בטקסט המקור. note — 'לפי התרגום של …' רק אם המילה העברית הזו מופיעה בדוח כבחירה של המתרגם, אחרת 'הצעה'. עד 90 ערכים.\n" +
    "- confidence: high אם נמצא תרגום ומקורות טובים על השיטה שלו; medium אם יש תרגום אבל מעט מידע על השיטה; low אם אין תרגום."
  );
}

const CARD_SCHEMA = {
  type: "object",
  properties: {
    hebrewTitle: { type: "string" },
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { translator: { type: "string" }, year: { type: "string" }, publisher: { type: "string" }, notes: { type: "string" } },
        required: ["translator"],
      },
    },
    model: { type: "string" },
    approach: { type: "string" },
    instructions: { type: "array", items: { type: "string" } },
    glossary: {
      type: "array",
      items: { type: "object", properties: { en: { type: "string" }, he: { type: "string" }, note: { type: "string" } }, required: ["en", "he"] },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["translations", "approach", "instructions", "glossary", "confidence"],
};

interface CardJson {
  hebrewTitle?: string;
  translations?: Translation[];
  model?: string;
  approach?: string;
  instructions?: string[] | string;
  glossary?: GlossaryEntry[];
  confidence?: string;
}

function mockCard(book: Book, names: { name: string; count: number }[]): CardJson {
  return {
    hebrewTitle: `${book.title} (דמה)`,
    translations: [{ translator: "מתרגם לדוגמה", year: "2005", publisher: "הוצאה לדוגמה", notes: "מצב דמה" }],
    model: "התרגום לדוגמה — כי הוא העדכני (מצב דמה)",
    approach: "עברית מדוברת וחיה, קרובה לקול של המספר. ביטויים חוזרים מתורגמים תמיד באותה צורה.",
    instructions: ["כתוב בעברית מדוברת של ימינו, לא בשפה ספרותית גבוהה.", "תרגם ביטוי חוזר תמיד באותה צורה."],
    glossary: names.slice(0, 12).map((n) => ({ en: n.name, he: `${n.name}-בעברית`, note: "הצעה" })),
    confidence: "medium",
  };
}

const clean = (s: unknown, max = 4000) => (typeof s === "string" ? s.replace(/\u0000/g, "").trim().slice(0, max) : "");

/** "לפי התרגום של…" רק כשגם הצורה במקור וגם הצורה העברית באמת מופיעות בדוח המחקר;
 *  אחרת זו הצעה שלנו (כדי שהכרטיס לא ייחס למתרגם מה שלא נמצא). */
export function verifyNotes(glossary: GlossaryEntry[], report: string): GlossaryEntry[] {
  const words = (t: string) => t.replace(/[^\u0590-\u05FFa-zA-Z'׳״"\s-]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  const low = report.toLowerCase().replace(/[’]/g, "'");
  return glossary.map((g) => {
    if (!g.note || !/לפי/.test(g.note)) return g;
    const ok = low.includes(g.en.toLowerCase().replace(/[’]/g, "'")) && words(g.he).every((w) => report.includes(w));
    return ok ? g : { ...g, note: "הצעה ברוח התרגום" };
  });
}

export function normalizeCard(j: CardJson): Omit<TranslationCard, "id" | "createdAt" | "source" | "sources" | "report"> {
  const instructions = Array.isArray(j.instructions) ? j.instructions.map((x) => clean(x, 600)).filter(Boolean).join("\n") : clean(j.instructions, 6000);
  const seen = new Set<string>();
  const glossary: GlossaryEntry[] = [];
  for (const g of j.glossary ?? []) {
    const en = clean(g?.en, 80);
    const he = clean(g?.he, 80);
    if (!en || !he || seen.has(en.toLowerCase())) continue;
    seen.add(en.toLowerCase());
    glossary.push({ en, he, ...(clean(g.note, 120) ? { note: clean(g.note, 120) } : {}) });
  }
  const conf = j.confidence === "high" || j.confidence === "low" ? j.confidence : "medium";
  return {
    hebrewTitle: clean(j.hebrewTitle, 200) || undefined,
    translations: (j.translations ?? []).map((t) => ({ translator: clean(t?.translator, 120), year: clean(t?.year, 20) || undefined, publisher: clean(t?.publisher, 120) || undefined, notes: clean(t?.notes, 400) || undefined })).filter((t) => t.translator).slice(0, 8),
    model: clean(j.model, 600) || undefined,
    approach: clean(j.approach, 2000),
    instructions,
    glossary: glossary.slice(0, 100),
    confidence: conf,
  };
}

/** שם שכבר מכוסה במילון — כערך בפני עצמו או כחלק משם מלא ("Holden" בתוך "Holden Caulfield"). */
const coveredName = (glossary: GlossaryEntry[], name: string) =>
  glossary.some((g) => g.en.toLowerCase() === name.toLowerCase() || g.en.split(/\s+/).includes(name));

/** שמות שחוזרים 5 פעמים ומעלה וחסרים במילון — תעתיק עברי אחד קבוע לכל אחד (קריאה זולה אחת), כדי שכל שם ייכתב תמיד אותו דבר. */
export async function completeNames(book: Book, glossary: GlossaryEntry[], names: { name: string; count: number }[], onUsage?: (u: Usage) => void): Promise<GlossaryEntry[]> {
  const missing = names.filter((n) => n.count >= 5 && !coveredName(glossary, n.name)).slice(0, 40);
  if (!missing.length) return glossary;
  const examples = glossary.filter((g) => /^[A-Z]/.test(g.en)).slice(0, 15).map((g) => `${g.en} = ${g.he}`).join(", ");
  const j = await genJson<{ names: { en: string; he: string }[] }>(
    `הספר: ${bookLabel(book)}.\nתעתק לעברית את השמות האלה מתוך הספר, בכתיב עברי מקובל (כמו בתרגומים לעברית) ונוח להקראה בקול. ` +
      `ראשי תיבות של שם — כמו שהוגים אותם (למשל די־בי). מילה שאינה שם (למשל שם של מוסד או מקום) — תרגם כמקובל.\n` +
      (examples ? `לעקביות, כך כבר נקבעו שמות אחרים: ${examples}\n` : "") +
      `השמות: ${missing.map((n) => n.name).join(", ")}`,
    "אתה עורך תרגום. החזר רק את הרשימה המבוקשת.",
    { type: "object", properties: { names: { type: "array", items: { type: "object", properties: { en: { type: "string" }, he: { type: "string" } }, required: ["en", "he"] } } }, required: ["names"] },
    { names: missing.map((n) => ({ en: n.name, he: `${n.name}-שם` })) },
    MODELS.text,
    onUsage,
  ).catch(() => ({ names: [] as { en: string; he: string }[] }));
  const wanted = new Set(missing.map((n) => n.name));
  const add = (j.names ?? [])
    .map((x) => ({ en: clean(x?.en, 80), he: clean(x?.he, 80) }))
    .filter((x) => x.en && x.he && wanted.has(x.en) && !coveredName(glossary, x.en))
    .map((x) => ({ ...x, note: "הצעה" }));
  return [...glossary, ...add];
}

/** רושם ניסיון מחקר (קובץ התחלה). אם כבר רץ מחקר אחר — מוותר (AlreadyResearching). */
export async function beginResearch(bookId: string, now = Date.now()): Promise<string> {
  const runId = String(now);
  const dir = D.runs(bookId);
  await store.writeJSON(`${dir}${runId}.start.json`, { at: new Date(now).toISOString() });
  // שני תהליכים שהתחילו כמעט ביחד (הלקוח וה-cron) — הראשון ממשיך, השני מוותר
  const paths = await store.listPaths(dir);
  const running = numericIds(paths, dir, /^(\d+)\.start\.json$/).filter(
    (k) => k !== runId && Number(k) <= now && now - Number(k) < RUN_STALE_MS && !paths.includes(`${dir}${k}.done.json`) && !paths.includes(`${dir}${k}.fail.json`),
  );
  if (running.length) {
    await store.remove(`${dir}${runId}.start.json`);
    throw new AlreadyResearching();
  }
  return runId;
}

/** מחקר מלא (שתי קריאות למודל הגדול) ושמירת כרטיס חדש. מסמן סוף/כישלון בקבצים נפרדים. */
export async function researchCard(book: Book, registeredRun?: string, opts: { reuse?: TranslationCard | null } = {}): Promise<TranslationCard> {
  const runId = registeredRun ?? (await beginResearch(book.id));
  const dir = D.runs(book.id);
  try {
    const texts = book.sections.map((s) => cleanSectionText(book, s.i)); // בלי הכותרת הרצה ("The Catcher in the Rye" בכל עמוד)
    const names = candidateNames(texts.join("\n\n").length > 600_000 ? texts.slice(0, Math.ceil(texts.length / 2)) : texts);
    const sample = styleSample(book);
    // "סדר מחדש": משתמשים בדוח המחקר הקיים (בלי חיפוש חדש) — רק בונים את הכרטיס מחדש
    const r =
      opts.reuse?.report
        ? { text: opts.reuse.report, sources: opts.reuse.sources, usage: { model: "reuse", input: 0, output: 0, searches: 0 } as Usage }
        : await researchWithSearch(researchPrompt(book), RESEARCH_SYSTEM);
    const usage: Usage[] = [r.usage];
    const j = await genJson<CardJson>(structurePrompt(book, r.text, names, sample), STRUCTURE_SYSTEM, CARD_SCHEMA, mockCard(book, names), undefined, (u) => usage.push(u));
    const norm = normalizeCard(j);
    norm.glossary = await completeNames(book, verifyNotes(norm.glossary, r.text), names, (u) => usage.push(u));
    const cost = { usd: Math.round(usageCostUsd(usage) * 10000) / 10000, searches: usage.reduce((n, u) => n + u.searches, 0) };
    const card = await saveCard(book.id, { ...norm, source: "research", sources: r.sources.slice(0, 15), report: r.text.slice(0, 30000), cost });
    await store.writeJSON(`${dir}${runId}.done.json`, { at: new Date().toISOString(), card: card.id });
    return card;
  } catch (e) {
    const error = String((e as Error)?.message || e).slice(0, 400);
    await store.writeJSON(`${dir}${runId}.fail.json`, { at: new Date().toISOString(), error });
    throw e;
  }
}

export class AlreadyResearching extends Error {
  constructor() {
    super("המחקר כבר רץ");
  }
}

async function waitForCard(bookId: string, ms: number): Promise<TranslationCard | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, MOCK ? 300 : 5000));
    const s = await cardStatus(bookId);
    if (s.state !== "researching") return s.card;
  }
  return latestCard(bookId);
}

/** הכרטיס לתרגום. כרטיס קיים — תמיד בשימוש (גם בזמן "חקור מחדש"). אם אין: חוקרים עכשיו, או מחכים למחקר שכבר רץ.
 *  null אם אין כרטיס ואי אפשר עכשיו (ואז מתרגמים בלי — עדיף מלעצור את ההאזנה). */
export async function ensureCard(book: Book, opts: { wait?: boolean; waitMs?: number } = {}): Promise<TranslationCard | null> {
  if (book.lang === "he") return null;
  const st = await cardStatus(book.id);
  if (st.card) return st.card;
  const waitMs = opts.waitMs ?? 200_000;
  if (st.state === "researching") return opts.wait ? waitForCard(book.id, waitMs) : null;
  // נכשל לאחרונה — לא מנסים שוב לבד (ידנית: "חקור מחדש")
  if (st.state === "error" && Date.now() - new Date(st.at).getTime() < RETRY_AFTER_ERROR_MS) return null;
  try {
    return await researchCard(book);
  } catch (e) {
    if (e instanceof AlreadyResearching) return opts.wait ? waitForCard(book.id, waitMs) : null;
    console.warn("translation card:", (e as Error).message);
    return latestCard(book.id);
  }
}

/** עריכה ידנית: הנחיות ומילון (שורה לכל ערך: "Holden = הולדן" או "Holden = הולדן // הערה"). נשמר כגרסה חדשה. */
export async function editCard(bookId: string, edit: { instructions?: string; glossaryText?: string; model?: string }): Promise<TranslationCard> {
  const prev = await latestCard(bookId);
  const glossary = edit.glossaryText != null ? parseGlossary(edit.glossaryText) : prev?.glossary ?? [];
  return saveCard(bookId, {
    hebrewTitle: prev?.hebrewTitle,
    translations: prev?.translations ?? [],
    model: edit.model != null ? clean(edit.model, 600) || undefined : prev?.model,
    approach: prev?.approach ?? "",
    instructions: edit.instructions != null ? clean(edit.instructions, 6000) : prev?.instructions ?? "",
    glossary,
    confidence: prev?.confidence ?? "low",
    sources: prev?.sources ?? [],
    report: prev?.report,
    cost: prev?.cost,
    source: "edit",
  });
}

/** המילון כטקסט לעריכה: שורה לכל ערך. הערה מוצגת רק כשהיא אומרת משהו ("לפי התרגום של…"), לא "הצעה". */
export function glossaryToText(g: GlossaryEntry[]): string {
  return g.map((e) => `${e.en} = ${e.he}${e.note && !e.note.startsWith("הצעה") ? ` // ${e.note}` : ""}`).join("\n");
}

export function parseGlossary(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const [main, ...rest] = line.split("//");
    const m = main.match(/^\s*(.+?)\s*(?:=|→|->|—|–)\s*(.+?)\s*$/);
    if (!m) continue;
    const en = m[1].trim().slice(0, 80);
    const he = m[2].trim().slice(0, 80);
    if (!en || !he || seen.has(en.toLowerCase())) continue;
    seen.add(en.toLowerCase());
    const note = rest.join("//").trim().slice(0, 120);
    out.push({ en, he, ...(note ? { note } : {}) });
  }
  return out;
}

// ---------- ההנחיות למתרגם ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ערכי המילון שרלוונטיים לקטע: הצורה מופיעה בו (או, לשם מלא, אחד השמות שבו). */
export function relevantGlossary(glossary: GlossaryEntry[], text: string, max = 45): GlossaryEntry[] {
  const t = text.replace(/[’]/g, "'");
  const has = (w: string) => new RegExp(`(^|[^A-Za-z])${escapeRe(w.replace(/[’]/g, "'"))}(?=$|[^A-Za-z])`, "i").test(t);
  const out: GlossaryEntry[] = [];
  for (const g of glossary) {
    if (has(g.en)) out.push(g);
    else {
      const parts = g.en.split(/\s+/).filter((p) => /^[A-Z][a-z]{2,}$/.test(p) && !STOP.has(p));
      if (parts.length > 1 && parts.some((p) => new RegExp(`\\b${escapeRe(p)}\\b`).test(t))) out.push(g);
    }
    if (out.length >= max) break;
  }
  return out;
}

const BASE_SYSTEM =
  "אתה מתרגם ספרותי מעולה לעברית. תרגם את הקטע לעברית טבעית, זורמת ומדויקת, כמו ספר שיצא בהוצאה טובה. " +
  "התרגום מיועד להאזנה: משפטים שנשמעים טוב בקול. שמור על חלוקת הפסקאות בדיוק כמו במקור (אותו מספר פסקאות). " +
  "אל תוסיף הערות, כותרות, ניקוד או הסברים — רק את התרגום. אם הקטע הוא כותרת פרק בלבד, תרגם את הכותרת.";

export function translationPrompt(book: Book, i: number, card: TranslationCard | null, prevHebrew?: string | null): { system: string; prompt: string } {
  const sec = book.sections[i];
  const source = cleanSectionText(book, i); // בלי כותרות רצות, בלי שבירת פסקה באמצע משפט ורווחים כפולים מה-PDF
  let system = BASE_SYSTEM;
  if (card) {
    const g = relevantGlossary(card.glossary, source);
    system +=
      `\n\nכרטיס התרגום של הספר ${bookLabel(book)}` +
      (card.model ? ` — אנחנו כותבים ברוח ${card.model}` : "") +
      ".\nההנחיות:\n" +
      card.instructions
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith("-") ? l : `- ${l}`))
        .join("\n") +
      (g.length ? `\n\nמילון קבוע — בכל פעם שהצורה מופיעה, השתמש בדיוק בתרגום הזה (בהטיות הנדרשות):\n${g.map((e) => `${e.en} = ${e.he}`).join("\n")}` : "") +
      "\n\nחשוב: תרגם בעצמך. אל תשחזר ואל תצטט טקסט מתרגום קיים — רק את הסגנון, המשלב והגישה.";
  }
  const prevSrc = i > 0 ? book.sections[i - 1].text.slice(-500) : "";
  const prompt =
    (prevSrc ? `(הקשר — סוף הקטע הקודם במקור, לא לתרגם:)\n${prevSrc}\n\n` : "") +
    (prevHebrew ? `(הקשר — סוף התרגום שלנו לקטע הקודם, כדי להמשיך באותו קול ובאותם מונחים; לא לחזור עליו:)\n${prevHebrew.slice(-700)}\n\n` : "") +
    `(הקטע לתרגום:)\n${source}`;
  return { system, prompt };
}
