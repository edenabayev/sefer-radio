// "לחשוב לעומק": המודל החי מעביר לכאן את השאלה, המוח הגדול עונה, והמודל החי מקריא.
import { ok, fail, authorized } from "@/lib/api";
import { getBook } from "@/lib/books";
import { deepAnswer, type Turn } from "@/lib/conversation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const body = (await req.json().catch(() => ({}))) as { section?: number; question?: string; transcript?: Turn[] };
    if (!body.question?.trim()) return fail("אין שאלה", 400);
    const answer = await deepAnswer(book, body.section ?? 0, body.question, Array.isArray(body.transcript) ? body.transcript.slice(-20) : []);
    return ok({ answer });
  } catch (e) {
    return fail(e);
  }
}
