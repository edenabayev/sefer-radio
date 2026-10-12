import { ok, fail } from "@/lib/api";
import { listModels, MODELS, MOCK, VOICE } from "@/lib/gemini";
import { storageMode } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request) {
  try {
    const models = await listModels();
    const want = [MODELS.text, MODELS.tts, MODELS.pdf];
    const missing = MOCK ? [] : want.filter((m) => !models.some((n) => n.endsWith("/" + m) || n === m));
    return ok({ mock: MOCK, storage: storageMode, models: MODELS, voice: VOICE, missing, available: models.filter((n) => /tts|flash|pro/i.test(n)) });
  } catch (e) {
    return fail(e);
  }
}
