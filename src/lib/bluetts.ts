// BlueTTS (קוד פתוח, MIT) דרך ההדגמה הציבורית ב-Hugging Face — לצורך השוואה בלבד, לא להפקה.
import { wavToPcm } from "./gemini";

const SPACE = "https://notmax123-bluev2.hf.space";

export async function blueTts(text: string, voice: string, lang = "he"): Promise<{ pcm: Buffer; info: string }> {
  const start = await fetch(`${SPACE}/gradio_api/call/synthesize_text_stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: [text, voice, lang, 8, 0.95, null] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!start.ok) throw new Error("BlueTTS: " + start.status);
  const { event_id } = (await start.json()) as { event_id: string };
  const sse = await fetch(`${SPACE}/gradio_api/call/synthesize_text_stream/${event_id}`, { signal: AbortSignal.timeout(240000) }).then((r) => r.text());
  const blocks = sse.split(/\n\n/).filter((b) => b.includes("data:"));
  let url = "";
  let info = "";
  for (const b of blocks) {
    const data = b.slice(b.indexOf("data:") + 5).trim();
    try {
      const j = JSON.parse(data);
      if (Array.isArray(j) && j[0]?.url) {
        url = j[0].url;
        info = String(j[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    } catch {
      if (/error/i.test(b)) throw new Error("BlueTTS: " + data.slice(0, 200));
    }
  }
  if (!url) throw new Error("BlueTTS לא החזיר שמע: " + sse.slice(0, 300));
  const wav = Buffer.from(await fetch(url, { signal: AbortSignal.timeout(60000) }).then((r) => r.arrayBuffer()));
  return { pcm: wavToPcm(wav), info };
}
