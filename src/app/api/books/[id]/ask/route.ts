import { ok, fail, authorized } from "@/lib/api";
import { answerQuestion, getBook } from "@/lib/books";

export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const form = await req.formData();
    const f = form.get("audio") as File | null;
    const i = Number(form.get("section"));
    if (!f) return fail("חסרה הקלטה", 400);
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const audio = Buffer.from(await f.arrayBuffer());
    return ok(await answerQuestion(book, i, audio, f.type || "audio/webm"));
  } catch (e) {
    return fail(e);
  }
}
