// כל הקריאות ל-Gemini במקום אחד: טקסט, קול, קריאת PDF, שאלה בקול.
// בלי מפתח (או עם MOCK_AI=1) — מצב דמה לבדיקות מקומיות.
import { GoogleGenAI, type GenerateContentConfig } from "@google/genai";
import { PDFDocument } from "pdf-lib";
import { fakePcm } from "./mp3";

export const MOCK = process.env.MOCK_AI === "1" || !process.env.GEMINI_API_KEY;

export const MODELS = {
  text: process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash",
  tts: process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts",
  pdf: process.env.GEMINI_PDF_MODEL || process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash",
};
export const VOICE = process.env.GEMINI_VOICE || "Zephyr";
export const SAMPLE_RATE = 24000;

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

async function withThinkingFallback<T>(fn: (cfg: GenerateContentConfig) => Promise<T>, base: GenerateContentConfig): Promise<T> {
  try {
    return await fn({ ...base, thinkingConfig: { thinkingLevel: "LOW" as never } });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/thinking|unsupported|INVALID_ARGUMENT|400/i.test(msg)) return fn(base);
    throw e;
  }
}

export async function genText(prompt: string, system?: string, maxOutputTokens = 8192): Promise<string> {
  if (MOCK) return `[דמה] ${prompt.slice(0, 200)}`;
  const base: GenerateContentConfig = { systemInstruction: system, maxOutputTokens, temperature: 0.4 };
  const res = await withThinkingFallback(
    (config) => ai().models.generateContent({ model: MODELS.text, contents: prompt, config }),
    base,
  );
  const text = res.text ?? "";
  if (!text.trim()) throw new Error("Gemini החזיר תשובה ריקה (" + JSON.stringify(res.candidates?.[0]?.finishReason) + ")");
  return text.trim();
}

/** מפרק טקסט ארוך לחתיכות שמנוע הקול מקבל בנוחות (לפי משפטים). */
export function splitForTts(text: string, max = 1800): string[] {
  const out: string[] = [];
  let buf = "";
  const sentences = text.split(/(?<=[.!?:;״”"])\s+|\n+/);
  for (const s of sentences) {
    if (!s.trim()) continue;
    if (buf.length + s.length + 1 > max && buf) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > max) {
      // משפט ענק — חותכים במילים
      const words = s.split(/\s+/);
      for (const w of words) {
        if (buf.length + w.length + 1 > max && buf) {
          out.push(buf.trim());
          buf = "";
        }
        buf += (buf ? " " : "") + w;
      }
      continue;
    }
    buf += (buf ? " " : "") + s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const STYLE: Record<string, string> = {
  he: "קרא את הטקסט הבא בקול בעברית, בקצב רגוע וברור, כמו קריין ספרי שמע. קרא רק את הטקסט עצמו, בלי להוסיף דבר:\n\n",
  en: "Read the following text aloud in English, in a calm, clear audiobook-narrator voice. Read only the text itself, adding nothing:\n\n",
};

/** טקסט → PCM 16 ביט מונו 24kHz (ב-Buffer). */
export async function tts(text: string, lang: string, voice = VOICE): Promise<Buffer> {
  const parts = splitForTts(text);
  if (MOCK) {
    const secs = Math.max(2, Math.min(12, text.length / 150));
    return fakePcm(secs);
  }
  const bufs: Buffer[] = [];
  for (const part of parts) {
    const res = await ai().models.generateContent({
      model: MODELS.tts,
      contents: (STYLE[lang] ?? STYLE.en) + part,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    });
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!data?.data) throw new Error("Gemini TTS לא החזיר שמע (" + JSON.stringify(res.candidates?.[0]?.finishReason) + ")");
    bufs.push(Buffer.from(data.data, "base64"));
  }
  return Buffer.concat(bufs);
}

export const PDF_CHUNK_PAGES = 25;

export async function pdfPageCount(pdf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  return doc.getPageCount();
}

/** חותך טווח עמודים מה-PDF ומבקש מ-Gemini להעתיק את הטקסט כמו שהוא, עם כותרות מסומנות. */
export async function extractPdfPages(pdf: Buffer, fromPage: number, toPage: number): Promise<string> {
  if (MOCK) {
    return Array.from({ length: toPage - fromPage + 1 }, (_, k) => {
      const p = fromPage + k;
      return (p % 10 === 1 ? `## פרק דמה ${Math.ceil(p / 10)}\n\n` : "") + `זהו טקסט דמה של עמוד ${p}. `.repeat(20);
    }).join("\n\n");
  }
  const src = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const idx = Array.from({ length: toPage - fromPage + 1 }, (_, k) => fromPage - 1 + k);
  const pages = await out.copyPages(src, idx);
  pages.forEach((p) => out.addPage(p));
  const bytes = Buffer.from(await out.save());
  const prompt =
    "This is part of a book. Transcribe ALL the text in these pages exactly, in correct reading order, as plain text. " +
    "Rules: keep paragraphs separated by a blank line; mark chapter or section headings on their own line starting with '## '; " +
    "join words split across lines; drop page numbers, running headers and footers; do not translate, summarize, comment or add anything. " +
    "For Hebrew text, output the Hebrew letters in normal logical order (not reversed). If a page has no text, output nothing for it.";
  const res = await withThinkingFallback(
    (config) =>
      ai().models.generateContent({
        model: MODELS.pdf,
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: bytes.toString("base64") } }, { text: prompt }] }],
        config,
      }),
    { maxOutputTokens: 65000, temperature: 0 },
  );
  return (res.text ?? "").trim();
}

/** שאלה מוקלטת (קול) על קטע — התשובה כטקסט בעברית. */
export async function askWithAudio(audio: Buffer, mimeType: string, context: string): Promise<string> {
  if (MOCK) return "[דמה] זו תשובה לשאלה שלך על הקטע הזה. בקצרה: הרעיון המרכזי כאן הוא מה שהמחבר מכנה 'הדבר שבשליטתנו'.";
  const system =
    "אתה מורה סבלני ובהיר. המשתמש נוהג ברכב ושומע ספר. הוא שאל שאלה בקול על הקטע שמופיע להלן. " +
    "ענה בעברית מדוברת וברורה, בלי ניקוד, בלי סימני עיצוב, בלי רשימות — טקסט שמיועד להקראה בקול. עד 120 מילים. " +
    "אם השאלה לא קשורה לקטע, ענה בכל זאת בקצרה ובנימוס.";
  const res = await withThinkingFallback(
    (config) =>
      ai().models.generateContent({
        model: MODELS.text,
        contents: [{ role: "user", parts: [{ text: "ההקשר (הקטע הנוכחי וההסבר עליו):\n\n" + context + "\n\nהשאלה המוקלטת:" }, { inlineData: { mimeType, data: audio.toString("base64") } }] }],
        config,
      }),
    { systemInstruction: system, maxOutputTokens: 2048, temperature: 0.5 },
  );
  return (res.text ?? "").trim();
}

export async function listModels(): Promise<string[]> {
  if (MOCK) return ["(mock)"];
  const names: string[] = [];
  const pager = await ai().models.list({ config: { pageSize: 100 } });
  for await (const m of pager) names.push(m.name ?? "");
  return names;
}
