import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { buildManifest, audioVoiceFor, langFor } from "@/lib/stream-params";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const sp = new URL(req.url).searchParams;
    const progress = await getProgress(id);
    const lang = langFor(book, sp.get("lang"), progress);
    const voice = audioVoiceFor(sp.get("voice"), lang, progress);
    const from = Math.max(0, Math.min(book.sections.length - 1, Number(sp.get("from") ?? progress.section) || 0));
    const study = sp.get("study") === "0" ? false : progress.study !== false;
    // עם upto — מחזירים בדיוק את הזרם שבכתובת (לבדיקות ולסנכרון), לא "כל מה שמוכן עכשיו"
    const upto = sp.get("upto");
    const fixed = upto != null ? { upto: Number(upto), qs: (sp.get("qs") || "").split(",").filter(Boolean).map(Number) } : undefined;
    const max = Number(sp.get("max")) || undefined; // שניות — לזרם הבא שנטען מראש לזיכרון
    return ok(await buildManifest(book, from, lang, voice, study, fixed, max));
  } catch (e) {
    return fail(e);
  }
}
