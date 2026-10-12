import { ok, fail, authorized } from "@/lib/api";
import { ensureAudio, getBook } from "@/lib/books";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id, n } = await ctx.params;
    const lang = new URL(req.url).searchParams.get("lang") === "orig" ? "orig" : "he";
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const i = Number(n);
    if (!book.sections[i]) return fail("הקטע עוד לא קיים", 404);
    return ok(await ensureAudio(book, i, lang));
  } catch (e) {
    return fail(e);
  }
}
