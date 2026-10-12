// המרה של שמע גולמי (PCM 16 ביט, מונו) ל-MP3 — Gemini מחזיר PCM, הטלפון רוצה MP3.

export async function pcm16ToMp3(pcm: Buffer, sampleRate = 24000, kbps = 48): Promise<Buffer> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const enc = new Mp3Encoder(1, sampleRate, kbps);
  const chunks: Buffer[] = [];
  const block = 1152 * 8;
  for (let i = 0; i < samples.length; i += block) {
    const part = samples.subarray(i, Math.min(i + block, samples.length));
    const out = enc.encodeBuffer(part);
    if (out.length) chunks.push(Buffer.from(out.buffer, out.byteOffset, out.length));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(Buffer.from(tail.buffer, tail.byteOffset, tail.length));
  return Buffer.concat(chunks);
}

/** צליל דמה לבדיקות בלי מפתח: טון עדין באורך שתלוי באורך הטקסט. */
export function fakePcm(seconds: number, sampleRate = 24000): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 4, (seconds - t) * 4);
    const v = Math.sin(2 * Math.PI * 220 * t) * 0.2 * env + Math.sin(2 * Math.PI * 330 * t) * 0.1 * env;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}
