import { ok } from "@/lib/api";
import { VOICES, VOICE } from "@/lib/gemini";
import { KOKORO_VOICES, KOKORO_DEFAULT } from "@/lib/kokoro-voices";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ voices: VOICES, default: VOICE, voicesEn: KOKORO_VOICES, defaultEn: KOKORO_DEFAULT });
}
