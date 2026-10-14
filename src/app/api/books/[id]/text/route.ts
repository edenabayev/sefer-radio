import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { readHeMap, readyMap, audioLang } from "@/lib/prepare";
import { VOICE } from "@/lib/gemini";
import { isKokoroVoice, KOKORO_DEFAULT } from "@/lib/kokoro-voices";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const progress = await getProgress(id);
    const sp = new URL(req.url).searchParams;
    const lang = audioLang(book, sp.get("lang") === "orig" ? "orig" : sp.get("lang") === "he" ? "he" : progress.lang);
    const wanted = sp.get("voice");
    const voice = lang === "en" ? (isKokoroVoice(wanted) ? wanted : progress.voiceEn || KOKORO_DEFAULT) : (wanted && !isKokoroVoice(wanted) ? wanted : progress.voice || VOICE);
    const [he, ready] = await Promise.all([readHeMap(book), readyMap(book, voice, lang)]);
    return ok({ he, ready, voice, lang });
  } catch (e) {
    return fail(e);
  }
}
