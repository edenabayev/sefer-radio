// השוואת קולות בעברית: אותה פסקה בכמה מנועים, נשמר ב-Blob ומוצג בדף /compare.
import { ok, fail, authorized } from "@/lib/api";
import * as store from "@/lib/storage";
import { ttsChunk, SAMPLE_RATE } from "@/lib/gemini";
import { pcm16ToMp3 } from "@/lib/mp3";
import { blueTts } from "@/lib/bluetts";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

interface Sample {
  id: string;
  label: string;
  note: string;
  url?: string;
  error?: string;
  seconds?: number;
  ms?: number;
}

const CANDIDATES: { id: string; label: string; note: string; run: (t: string) => Promise<{ pcm: Buffer; info?: string }> }[] = [
  { id: "gemini-lite-puck", label: "גוגל — Puck (מה שיש היום)", note: "gemini-3.8-flash-lite-tts · בתשלום, הזול של גוגל", run: async (t) => ({ pcm: await ttsChunk(t, "Puck", "gemini-3.8-flash-lite-tts") }) },
  { id: "gemini-flash-puck", label: "גוגל — Puck, דגם מלא", note: "gemini-3.8-flash-tts · בתשלום, יקר יותר מה-lite", run: async (t) => ({ pcm: await ttsChunk(t, "Puck", "gemini-3.8-flash-tts") }) },
  { id: "gemini-31-puck", label: "גוגל — Puck, Gemini 3.1 Flash TTS", note: "מקום 1 בזירה של ivrit.ai · בתשלום", run: async (t) => ({ pcm: await ttsChunk(t, "Puck", "gemini-3.1-flash-tts-preview") }) },
  { id: "blue-daniel", label: "BlueTTS — Daniel", note: "קוד פתוח (MIT) · חינם · רץ על מחשב רגיל", run: (t) => blueTts(t, "Daniel") },
  { id: "blue-adam", label: "BlueTTS — Adam", note: "קוד פתוח (MIT) · חינם", run: (t) => blueTts(t, "Adam") },
  { id: "blue-noa", label: "BlueTTS — Noa", note: "קוד פתוח (MIT) · חינם · קול נשי", run: (t) => blueTts(t, "Noa") },
];

export async function GET(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  return ok((await store.readJSON("compare/latest.json")) ?? { samples: [] });
}

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { text } = (await req.json()) as { text: string };
    if (!text?.trim()) return fail("אין טקסט", 400);
    const stamp = Date.now();
    const samples: Sample[] = await Promise.all(
      CANDIDATES.map(async (c) => {
        const t0 = Date.now();
        try {
          const { pcm, info } = await c.run(text);
          const url = await store.writeBytes(`compare/${stamp}/${c.id}.mp3`, await pcm16ToMp3(pcm, SAMPLE_RATE), "audio/mpeg");
          return { id: c.id, label: c.label, note: c.note + (info ? " · " + info : ""), url, seconds: +(pcm.length / 2 / SAMPLE_RATE).toFixed(1), ms: Date.now() - t0 };
        } catch (e) {
          return { id: c.id, label: c.label, note: c.note, error: (e as Error).message };
        }
      }),
    );
    const result = { text, at: new Date(stamp).toISOString(), samples };
    await store.writeJSON(`compare/${stamp}.json`, result);
    await store.writeJSON("compare/latest.json", result);
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
