import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { recap } from "@/lib/prepare";
import { VOICE } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const upto = Number(new URL(req.url).searchParams.get("upto") ?? 0);
    const progress = await getProgress(id);
    return ok(await recap(book, Math.max(1, upto), progress.voice || VOICE));
  } catch (e) {
    return fail(e);
  }
}
