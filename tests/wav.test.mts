import { wavToPcm } from "@/lib/gemini";
import { fakePcm } from "@/lib/mp3";
// בונים WAV: כותרת + fmt + data + גוש זבל בסוף (כמו שגמיני מחזיר)
const pcm = fakePcm(1, 24000);
const junk = Buffer.alloc(7200, 0x4c);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length + junk.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([header, pcm, junk]);
const out = wavToPcm(wav);
if (out.length !== pcm.length || !out.equals(pcm)) throw new Error(`wav parse failed: ${out.length} vs ${pcm.length}`);
// קצב אחר → התאמה
const h2 = Buffer.from(header); h2.writeUInt32LE(48000, 24);
const out2 = wavToPcm(Buffer.concat([h2, pcm]));
if (Math.abs(out2.length - pcm.length / 2) > 4) throw new Error("resample failed " + out2.length);
// שמע גולמי נשאר כמו שהוא
if (!wavToPcm(pcm).equals(pcm)) throw new Error("raw passthrough failed");
console.log("WAV OK", out.length, out2.length);
