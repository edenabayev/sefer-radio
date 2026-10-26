import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { readHeMap, readyMap, audioLang, questionDirFor } from "@/lib/prepare";
import * as store from "@/lib/storage";
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
    const qDir = questionDirFor(book, voice);
    const [he, ready, qPaths] = await Promise.all([readHeMap(book), readyMap(book, voice, lang), lang === "he" ? store.listPaths(qDir) : Promise.resolve([] as string[])]);
    // שאלות סוף פרק שכבר מוכנות — כדי שהנגן יבנה מחדש זרם שנבנה לפניהן
    const questions = qPaths.map((p) => p.slice(qDir.length).match(/^(\d+)\.mp3$/)?.[1]).filter((x): x is string => !!x).map(Number);
    return ok({ he, ready, questions, voice, lang });
  } catch (e) {
    return fail(e);
  }
}
