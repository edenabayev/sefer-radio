import { ok, fail, authorized } from "@/lib/api";
import { getBook } from "@/lib/books";
import { voicePreview } from "@/lib/prepare";
import { VOICES } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const voice = new URL(req.url).searchParams.get("voice") || "";
    if (!VOICES.some((v) => v.id === voice)) return fail("קול לא מוכר", 400);
    const book = await getBook(id);
    if (!book || !book.sections.length) return fail("אין ספר כזה", 404);
    return ok({ url: await voicePreview(book, voice) });
  } catch (e) {
    return fail(e);
  }
}
