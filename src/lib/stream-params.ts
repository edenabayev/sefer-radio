// פענוח שפה וקול מתוך פרמטרים של כתובת — משותף למניפסט ולזרם.
import type { Book, Progress } from "./books";
import { audioLang } from "./prepare";
import { VOICE } from "./gemini";
import { isKokoroVoice, KOKORO_DEFAULT } from "./kokoro-voices";
export { buildManifest } from "./stream";

export function langFor(book: Book, param: string | null, progress: Progress): "he" | "en" {
  return audioLang(book, param === "orig" ? "orig" : param === "he" ? "he" : progress.lang);
}

export function audioVoiceFor(param: string | null, lang: "he" | "en", progress: Progress): string {
  if (lang === "en") return isKokoroVoice(param) ? param : progress.voiceEn || KOKORO_DEFAULT;
  return param && !isKokoroVoice(param) ? param : progress.voice || VOICE;
}
