// הקלטה מחדש של קטעים בודדים (למשל קטע שגוגל סירב לתרגם, ועכשיו מתורגם בגיבוי של Google Translate).
// POST {sections: number[], voice?} — אחד אחרי השני (חשוב: הזמנים בשמות הקבצים עולים בסדר, והזרמים נשארים יציבים).
// POST {probe: "text"} — בדיקה שהגיבוי (Google Translate) עובד.
import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress, rerecordSection } from "@/lib/books";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { sections?: number[]; voice?: string; probe?: string };
    if (body.probe) {
      // איזה מפתח בשימוש (4 התווים האחרונים, כמו ש-AI Studio מציג) — כדי לדעת לאיזה מפתח להרשות את Google Translate
      const key = process.env.GOOGLE_TRANSLATE_KEY || process.env.GEMINI_API_KEY || "";
      const { googleTranslate } = await import("@/lib/gtranslate");
      try {
        return ok({ keyTail: key.slice(-4), probe: (await googleTranslate([body.probe], "he")).join("\n") });
      } catch (e) {
        return ok({ keyTail: key.slice(-4), error: (e as Error).message });
      }
    }
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const voice = body.voice || (await getProgress(id)).voice || undefined;
    const results: unknown[] = [];
    for (const i of body.sections ?? []) {
      try {
        results.push(await rerecordSection(book, i, voice));
      } catch (e) {
        results.push({ section: i, error: (e as Error).message });
      }
    }
    return ok({ results });
  } catch (e) {
    return fail(e);
  }
}
