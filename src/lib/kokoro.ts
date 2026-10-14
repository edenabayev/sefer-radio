// Kokoro-82M: מודל הקראה בקוד פתוח (Apache 2.0) שרץ על המעבד של השרת — בלי ספק חיצוני, בלי מפתח, בלי עלות לפי תו.
// משמש להקראה באנגלית (המקור). המודל (~90MB) יורד פעם אחת לכל שרת ונשמר ב-/tmp.
import { SAMPLE_RATE, MOCK } from "./gemini";
import { fakePcm } from "./mp3";

import { KOKORO_DEFAULT } from "./kokoro-voices";

type Kokoro = { generate: (text: string, opts: { voice: string; speed?: number }) => Promise<{ audio: Float32Array; sampling_rate: number }> };
const models = new Map<string, Promise<Kokoro>>();
export type KokoroDtype = "q8" | "fp32" | "q4" | "fp16" | "q4f16";

async function model(dtype: KokoroDtype = (process.env.KOKORO_DTYPE as KokoroDtype) || "fp32"): Promise<Kokoro> {
  let p = models.get(dtype);
  if (!p) {
    p = (async () => {
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = process.env.KOKORO_CACHE || "/tmp/hf-cache";
      tf.env.allowLocalModels = false;
      const { KokoroTTS } = await import("kokoro-js");
      return (await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype, device: "cpu" })) as unknown as Kokoro;
    })();
    models.set(dtype, p);
    p.catch(() => models.delete(dtype));
  }
  return p;
}

/** Float32 ב-24kHz → PCM 16 ביט, כמו ש-Gemini מחזיר — כדי שכל שאר הצינור (MP3, אחסון) יישאר זהה. */
function toPcm16(f32: Float32Array, rate: number): Buffer {
  const ratio = rate / SAMPLE_RATE;
  const n = Math.floor(f32.length / ratio);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, f32[Math.floor(i * ratio)]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return out;
}

/** מפרק לפסקאות/משפטים של עד ~500 תווים — המודל עובד הכי טוב על קטעים קצרים. */
function chunks(text: string, max = 500): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    let buf = "";
    for (const s of para.split(/(?<=[.!?;:])\s+/)) {
      if (!s.trim()) continue;
      if (buf.length + s.length + 1 > max && buf) {
        out.push(buf);
        buf = "";
      }
      buf += (buf ? " " : "") + s;
    }
    if (buf.trim()) out.push(buf);
  }
  return out;
}

export async function kokoroTts(text: string, voice = KOKORO_DEFAULT, dtype?: KokoroDtype): Promise<{ pcm: Buffer; stats: { loadMs: number; genMs: number; audioSec: number } }> {
  if (MOCK) return { pcm: fakePcm(Math.max(2, Math.min(12, text.length / 150))), stats: { loadMs: 0, genMs: 0, audioSec: 0 } };
  const t0 = Date.now();
  const m = await model(dtype);
  const loadMs = Date.now() - t0;
  const t1 = Date.now();
  const parts: Buffer[] = [];
  let audioSec = 0;
  const gap = Buffer.alloc(Math.round(SAMPLE_RATE * 0.35) * 2); // נשימה קצרה בין משפטים
  for (const c of chunks(text)) {
    const a = await m.generate(c, { voice });
    audioSec += a.audio.length / a.sampling_rate;
    parts.push(toPcm16(a.audio, a.sampling_rate), gap);
  }
  return { pcm: Buffer.concat(parts), stats: { loadMs, genMs: Date.now() - t1, audioSec } };
}
