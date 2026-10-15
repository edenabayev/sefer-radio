// בדיקה: כמה מהר Kokoro מקריא על המעבד של Vercel, והאם הקול נשמע טוב. שומר את התוצאה ב-Blob להאזנה.
import { ok, fail, authorized } from "@/lib/api";
import { kokoroTts, type KokoroDtype } from "@/lib/kokoro";
import { pcm16ToMp3 } from "@/lib/mp3";
import { SAMPLE_RATE } from "@/lib/gemini";
import * as store from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const sp = new URL(req.url).searchParams;
    const text = sp.get("text") || "If you really want to hear about it, the first thing you will probably want to know is where I was born, and what my lousy childhood was like. In the first place, that stuff bores me, and in the second place, my parents would have about two hemorrhages apiece if I told anything pretty personal about them.";
    const voice = sp.get("voice") || "am_michael";
    const t0 = Date.now();
    const dtype = (sp.get("dtype") as KokoroDtype) || undefined;
    const { pcm, stats } = await kokoroTts(text, voice, { dtype });
    const mp3 = await pcm16ToMp3(pcm, SAMPLE_RATE);
    const url = await store.writeBytes(`probe/kokoro-${voice}-${Date.now()}.mp3`, mp3, "audio/mpeg");
    return ok({ dtype: dtype || "q8", ...stats, totalMs: Date.now() - t0, chars: text.length, rtf: +(stats.genMs / 1000 / stats.audioSec).toFixed(2), url, cpus: (await import("os")).cpus().length, mem: process.memoryUsage().rss });
  } catch (e) {
    return fail(e);
  }
}
