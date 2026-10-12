import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { liveSession } from "@/lib/prepare";
import { VOICE } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const body = (await req.json().catch(() => ({}))) as { section?: number };
    const progress = await getProgress(id);
    return ok(await liveSession(book, body.section ?? progress.section, progress.voice || VOICE));
  } catch (e) {
    return fail(e);
  }
}
