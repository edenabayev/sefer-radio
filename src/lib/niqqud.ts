// ניקוד עזר לפני ההקראה: הקול קורא עברית בלי ניקוד ומנחש (שׁ/שׂ, דגש ב-ב/כ/פ, תנועות במילים
// שאפשר לקרוא ביותר מדרך אחת). כאן מנקדים רק את המילים שבהן הוא עלול לטעות — והטקסט עצמו לא משתנה:
// כל מילה מהמודל נבדקת שאחרי מחיקת הניקוד היא בדיוק המילה המקורית, ואחרת נשארת המילה המקורית.
// הטקסט המנוקד הולך רק לקול; על המסך נשאר הטקסט הרגיל.
import * as store from "./storage";
import { genText, MOCK } from "./gemini";

/** סימני ניקוד וטעמים — בלי מקף עברי (05BE), פסק (05C0), סוף פסוק (05C3) ונו"ן הפוכה (05C6), שהם פיסוק. */
const MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;

export function stripNiqqud(s: string): string {
  return s.replace(MARKS, "");
}

export const hasNiqqud = (s: string) => /[ְ-ׇּׁׂ]/.test(s);

/** מכניסים לטקסט המקורי רק מילים מנוקדות שהאותיות שלהן זהות לגמרי למקור (כולל פיסוק צמוד).
 *  מילים שהמודל הוסיף, מחק או שינה — נשארות כמו במקור. התוצאה, בלי ניקוד, שווה בדיוק למקור. */
export function mergeNiqqud(original: string, vocalized: string): { text: string; marked: number; words: number } {
  const o = [...original.matchAll(/\S+/g)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
  const v = vocalized.match(/\S+/g) ?? [];
  const vKey = v.map(stripNiqqud);
  const pick = new Array<string | null>(o.length).fill(null);
  if (vKey.length === o.length && vKey.every((k, j) => k === o[j].w)) {
    for (let j = 0; j < o.length; j++) pick[j] = v[j];
  } else {
    // יישור לפי הרצף המשותף הארוך ביותר (LCS) — עמיד למילה שנוספה או נשמטה באמצע
    const n = o.length;
    const m = v.length;
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let a = n - 1; a >= 0; a--)
      for (let b = m - 1; b >= 0; b--)
        L[a * W + b] = o[a].w === vKey[b] ? L[(a + 1) * W + b + 1] + 1 : Math.max(L[(a + 1) * W + b], L[a * W + b + 1]);
    let a = 0;
    let b = 0;
    while (a < n && b < m) {
      if (o[a].w === vKey[b]) {
        pick[a] = v[b];
        a++;
        b++;
      } else if (L[(a + 1) * W + b] >= L[a * W + b + 1]) a++;
      else b++;
    }
  }
  let text = "";
  let pos = 0;
  let marked = 0;
  for (let j = 0; j < o.length; j++) {
    const p = pick[j];
    const use = p && p !== o[j].w && hasNiqqud(p) ? p : o[j].w;
    if (use !== o[j].w) marked++;
    text += original.slice(pos, o[j].at) + use;
    pos = o[j].at + o[j].w.length;
  }
  text += original.slice(pos);
  return { text, marked, words: o.length };
}

export const NIQQUD_SYSTEM = `אתה מנקד טקסט עברי לפני שמנוע הקראה קולי קורא אותו בקול.
המנוע קורא עברית בלי ניקוד ומנחש איך לקרוא, ולפעמים טועה: קורא שׁ במקום שׂ, קורא ב/כ/פ בלי דגש או עם דגש במקום הלא נכון, ובוחר תנועות לא נכונות במילים שאפשר לקרוא ביותר מדרך אחת.
המשימה: להחזיר את כל הטקסט, בדיוק כמו שהוא, ולהוסיף ניקוד רק במילים שבהן המנוע עלול לטעות.

מה לנקד:
1. כל ש שנהגית כמו ס — סמן בה את הנקודה השמאלית (שׂ), בכל מילה, גם במילים נפוצות (עשׂה, שׂמחה, ישׂראל, שׂם). אם זו הבעיה היחידה במילה, מספיק לסמן רק את הנקודה הזו.
2. מילה שאפשר לקרוא ביותר מדרך אחת, והקריאה הנכונה תלויה בהקשר (סֵפֶר / סִפֵּר / סַפָּר, חָלָב / חֵלֶב, דָּבָר / דִּבֵּר, מְנַהֵל / מִנְהָל, שׁוֹמֵר / שָׁמַר) — נקד את כל המילה לפי ההקשר.
3. מילה שבה ב, כ או פ עלולות להיקרא לא נכון (b או v, k או ch, p או f) — נקד את כל המילה, כולל דגש במקום הנכון.
4. מילה נדירה, גבוהה או ארכאית, ושם של אדם או מקום שאינו מוכר — נקד את כל המילה.

מה לא לנקד: מילים נפוצות שכל קורא קורא נכון גם בלי ניקוד. בדרך כלל מנקדים בין אפס לשלוש מילים במשפט.

כללים:
- אל תשנה אף אות, רווח, סימן פיסוק או מעבר שורה. אל תוסיף ואל תוריד ו או י — הכתיב נשאר בדיוק כמו שהוא, ורק מוסיפים סימני ניקוד על האותיות הקיימות.
- כשמנקדים מילה שלמה — מנקדים גם את אותיות השימוש שבתחילתה (ו, ה, ב, כ, ל, מ, ש), ומסמנים שׁ או שׂ.
- ו שהיא תנועה מנוקדת וֹ או וּ.
- אל תכתוב שום דבר חוץ מהטקסט: בלי הסבר, בלי כותרת, בלי מרכאות ובלי סימוני קוד.`;

/** חותכים בגבולות פסקה לחתיכות של עד ~3,000 תווים — כל חתיכה מנוקדת לבד (ובמקביל). */
export function chunksForNiqqud(text: string, max = 3000): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= max) {
      out.push(text.slice(start));
      break;
    }
    const window = text.slice(start, start + max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 3) cut = window.lastIndexOf("\n");
    if (cut < max / 3) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" "));
    if (cut <= 0) cut = max;
    out.push(text.slice(start, start + cut));
    start += cut;
  }
  return out;
}

function cleanModelOutput(t: string): string {
  return t.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
}

/** מנקד טקסט (רק את המילים המסופקות) ומחזיר אותו — באותן אותיות בדיוק. */
export async function vocalize(text: string): Promise<{ text: string; marked: number; words: number }> {
  const parts = chunksForNiqqud(text);
  const done = await Promise.all(
    parts.map(async (part) => {
      if (!/[א-ת]/.test(part)) return { text: part, marked: 0, words: 0 };
      const raw = await genText("הטקסט:\n\n" + part, NIQQUD_SYSTEM, 16384, { thinking: "MEDIUM", temperature: 0.1 });
      return mergeNiqqud(part, cleanModelOutput(raw));
    }),
  );
  return { text: done.map((d) => d.text).join(""), marked: done.reduce((s, d) => s + d.marked, 0), words: done.reduce((s, d) => s + d.words, 0) };
}

/** הטקסט המנוקד לקטע (נשמר פעם אחת). אם הניקוד נכשל — הטקסט הרגיל, כדי שההקראה לא תיעצר. */
export async function withNiqqud(path: string, text: string, label: string): Promise<string> {
  if (MOCK || !/[א-ת]/.test(text)) return text;
  const cached = await store.readText(path);
  if (cached && stripNiqqud(cached) === text) return cached;
  try {
    const t0 = Date.now();
    const r = await vocalize(text);
    await store.writeBytes(path, r.text, "text/plain; charset=utf-8");
    console.log(`niqqud ${label}: ${r.marked}/${r.words} words, ${Date.now() - t0}ms`);
    return r.text;
  } catch (e) {
    console.warn(`niqqud ${label} failed, reading without:`, (e as Error).message);
    return text;
  }
}
