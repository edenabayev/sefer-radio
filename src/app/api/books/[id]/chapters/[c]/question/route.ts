import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { chapterQuestion } from "@/lib/prepare";
import { VOICE } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request, ctx: { params: Promise<{ id: string; c: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id, c } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const progress = await getProgress(id);
    return ok(await chapterQuestion(book, Number(c), progress.voice || VOICE));
  } catch (e) {
    return fail(e);
  }
}
