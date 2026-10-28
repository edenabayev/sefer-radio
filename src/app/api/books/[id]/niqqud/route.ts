// ניקוד בהקראה העברית: מאיזה קטע השמע מוקלט מחדש עם ניקוד עזר.
// GET — המצב. POST {from?} — מסמן (ברירת מחדל: הקטע שאחרי המקום הנוכחי) ומתחיל להכין מיד, בלי לחכות ל-cron.
import { after } from "next/server";
import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress, setNqFrom } from "@/lib/books";
import { prepare } from "@/lib/prepare";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const p = await getProgress(id);
    return ok({ nqFrom: book.nqFrom ?? null, section: p.section, offset: p.offset, lang: p.lang });
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
    const body = (await req.json().catch(() => ({}))) as { from?: number };
    const p = await getProgress(id);
    const from = Number.isInteger(body.from) ? Math.max(0, body.from!) : p.section + 1;
    if (from >= book.sections.length) return fail("אין קטעים אחרי המקום הזה", 400);
    await setNqFrom(id, from);
    after(async () => {
      try {
        await prepare(id, { from: p.section, lang: "he", budgetMs: 270_000 });
      } catch (e) {
        console.warn("niqqud prepare", id, (e as Error).message);
      }
    });
    return ok({ nqFrom: from, section: p.section, offset: p.offset });
  } catch (e) {
    return fail(e);
  }
}
