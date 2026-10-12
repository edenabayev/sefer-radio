import { ok } from "@/lib/api";
import { VOICES, VOICE } from "@/lib/gemini";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ voices: VOICES, default: VOICE });
}
