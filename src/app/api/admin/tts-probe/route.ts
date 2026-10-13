// בדיקה: מה בדיוק Gemini TTS מחזיר (סוג, אורך, ומה יש בסוף החתיכה) — לחקירת רעש בסוף קטעים.
import { GoogleGenAI } from "@google/genai";
import { ok, fail, authorized } from "@/lib/api";
import { MODELS, VOICE } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function stats(pcm: Buffer, from: number, to: number) {
  let sum = 0, peak = 0, zc = 0, n = 0, prev = 0;
  for (let i = from; i + 1 < to; i += 2) {
    const v = pcm.readInt16LE(i) / 32768;
    sum += v * v; peak = Math.max(peak, Math.abs(v)); if (n && (v >= 0) !== (prev >= 0)) zc++; prev = v; n++;
  }
  return { rms: +Math.sqrt(sum / Math.max(1, n)).toFixed(3), peak: +peak.toFixed(2), zcr: +(zc / Math.max(1, n)).toFixed(2) };
}

export async function GET(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const text = new URL(req.url).searchParams.get("text") || "שלום, זוהי בדיקה קצרה של הקול.";
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const res = await ai.models.generateContent({
      model: MODELS.tts,
      contents: text,
      config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
    });
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const infos = parts.map((p) => ({ mime: p.inlineData?.mimeType, bytes: p.inlineData?.data ? Buffer.from(p.inlineData.data, "base64").length : 0, text: p.text?.slice(0, 80) }));
    const first = parts.find((p) => p.inlineData?.data)?.inlineData;
    if (!first?.data) return ok({ infos, finish: res.candidates?.[0]?.finishReason });
    const pcm = Buffer.from(first.data, "base64");
    const sec = 48000; // בייטים לשנייה ב-24kHz 16bit mono
    return ok({
      infos,
      parts: parts.length,
      bytes: pcm.length,
      odd: pcm.length % 2 === 1,
      seconds: +(pcm.length / sec).toFixed(2),
      head16: [...pcm.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
      windows: {
        first200ms: stats(pcm, 0, 9600),
        middle: stats(pcm, Math.floor(pcm.length / 2) & ~1, (Math.floor(pcm.length / 2) & ~1) + 9600),
        last600to300ms: stats(pcm, Math.max(0, pcm.length - 28800) & ~1, Math.max(0, pcm.length - 14400) & ~1),
        last300to150ms: stats(pcm, Math.max(0, pcm.length - 14400) & ~1, Math.max(0, pcm.length - 7200) & ~1),
        last150ms: stats(pcm, Math.max(0, pcm.length - 7200) & ~1, pcm.length),
      },
    });
  } catch (e) {
    return fail(e);
  }
}
