// כרטיס התרגום של ספר: מצב (אין / חוקר / מוכן / נכשל), הכרטיס עצמו, עריכה, דוגמה, ו"תרגם לפי הכרטיס".
import { after } from "next/server";
import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress, ensureTranslation, newTrGen, translationStats } from "@/lib/books";
import { AlreadyResearching, beginResearch, cardStatus, editCard, glossaryToText, researchCard } from "@/lib/translation";
import { MODELS } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // המחקר רץ אחרי התשובה (after) — עד כמה דקות

async function state(id: string) {
  const book = await getBook(id);
  if (!book) return null;
  const st = await cardStatus(id);
  const stats = await translationStats(book, st.card?.createdAt);
  return {
    ...st,
    glossaryText: st.card ? glossaryToText(st.card.glossary) : "",
    translated: stats.translated, // כמה קטעים כבר תורגמו (בדור הנוכחי)
    older: stats.older, // מתוכם — לפני הגרסה הנוכחית של הכרטיס
    gen: book.trGen ?? null,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const s = await state(id);
    if (!s) return fail("אין ספר כזה", 404);
    return ok(s);
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    if (book.lang === "he") return fail("הספר כבר בעברית — אין מה לתרגם", 400);
    const body = (await req.json().catch(() => ({}))) as {
      action?: "research" | "save" | "sample" | "apply";
      instructions?: string;
      glossaryText?: string;
      model?: string;
      section?: number;
      retranslate?: boolean;
    };

    if (body.action === "research") {
      // נרשם עכשיו (כדי שהמצב "חוקר" ייראה מיד), והמחקר עצמו רץ אחרי שהתשובה נשלחה
      let runId: string;
      try {
        runId = await beginResearch(id);
      } catch (e) {
        if (e instanceof AlreadyResearching) return ok(await state(id));
        throw e;
      }
      after(async () => {
        try {
          await researchCard(book, runId);
        } catch (e) {
          console.warn("tcard research", id, (e as Error).message);
        }
      });
      return ok(await state(id));
    }

    if (body.action === "save") {
      await editCard(id, { instructions: body.instructions, glossaryText: body.glossaryText, model: body.model });
      return ok(await state(id));
    }

    if (body.action === "sample") {
      // דוגמה: הקטע הנוכחי (או שביקשו) מתורגם לפי הכרטיס — בלי לשמור
      const progress = await getProgress(id);
      const i = Math.max(0, Math.min(book.sections.length - 1, Number.isInteger(body.section) ? Number(body.section) : progress.section));
      const model = body.model && [MODELS.text, MODELS.deep].includes(body.model) ? body.model : undefined;
      const text = await ensureTranslation(book, i, { save: false, model });
      return ok({ section: i, text, original: book.sections[i].text });
    }

    if (body.action === "apply") {
      // "תרגם מחדש לפי הכרטיס": דור חדש — כל התרגומים והשמע העברי ייווצרו מחדש, רק כשמאזינים להם
      let gen = book.trGen ?? null;
      if (body.retranslate) {
        const st = await cardStatus(id);
        gen = await newTrGen(id, st.card?.id);
      }
      return ok({ ...(await state(id)), gen });
    }

    return fail("פעולה לא מוכרת", 400);
  } catch (e) {
    return fail(e);
  }
}
