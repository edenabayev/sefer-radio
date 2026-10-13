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
  live: process.env.GEMINI_LIVE_MODEL || "", // נבחר בזמן ריצה מתוך הרשימה למטה
  deep: process.env.GEMINI_DEEP_MODEL || "gemini-3.1-pro-preview", // "המוח הגדול": שאלות עומק, כרטיס רקע, סיכומי שיחה
};
const LIVE_CANDIDATES = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest", "gemini-2.5-flash-native-audio-preview-12-2025"];
export const VOICE = process.env.GEMINI_VOICE || "Puck"; // מדורג ראשון בעברית בזירת ivrit.ai
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

/** המוח הגדול: מודל Pro עם חשיבה גבוהה. אם הוא לא זמין — Flash עם חשיבה גבוהה. */
export async function genDeep(prompt: string, system?: string, maxOutputTokens = 8192): Promise<string> {
  if (MOCK) return `[דמה-עומק] ${prompt.slice(0, 200)}`;
  const run = async (model: string, level: "HIGH" | "MEDIUM") => {
    const res = await ai().models.generateContent({
      model,
      contents: prompt,
      config: { systemInstruction: system, maxOutputTokens, temperature: 0.6, thinkingConfig: { thinkingLevel: level as never } },
    });
    const text = (res.text ?? "").trim();
    if (!text) throw new Error("תשובה ריקה (" + JSON.stringify(res.candidates?.[0]?.finishReason) + ")");
    return text;
  };
  try {
    return await run(MODELS.deep, "HIGH");
  } catch (e) {
    console.warn("deep model failed, falling back to text model:", (e as Error).message);
    try {
      return await run(MODELS.text, "HIGH");
    } catch {
      return genText(prompt, system, maxOutputTokens);
    }
  }
}

/** מפרק טקסט ארוך לחתיכות שמנוע הקול מקבל בנוחות (לפי משפטים). */
const bytes = (t: string) => Buffer.byteLength(t, "utf8");

/** ניקוי לפני הקראה: כתובות אינטרנט, שורות "מעודכן לתאריך" של בן־יהודה, סימני עיצוב, שלוש נקודות וקווים. */
export function cleanForTts(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/benyehuda\.org|פרויקט בן.יהודה|מעודכן לתאריך|^\s*https?:\/\//.test(line))
    .join("\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>`]+/g, "")
    .replace(/…/g, ".")
    .replace(/\s[–—-]\s/g, ", ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** מסיר ניקוד וטעמים (כשהמנוע נכשל על טקסט מנוקד). */
export function stripNiqqud(text: string): string {
  return text.replace(/[\u0591-\u05C7]/g, "");
}

/** מפרק טקסט ארוך לחתיכות שמנוע הקול מקבל — לפי *בייטים* (עברית מנוקדת שוקלת הרבה יותר מאותיות). */
export function splitForTts(text: string, maxBytes = 3000): string[] {
  const out: string[] = [];
  let buf = "";
  const sentences = text.split(/(?<=[.!?:;״”"])\s+|\n+/);
  const push = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const s of sentences) {
    if (!s.trim()) continue;
    if (bytes(buf) + bytes(s) + 1 > maxBytes && buf) push();
    if (bytes(s) > maxBytes) {
      // משפט ענק — חותכים במילים
      for (const w of s.split(/\s+/)) {
        if (bytes(buf) + bytes(w) + 1 > maxBytes && buf) push();
        buf += (buf ? " " : "") + w;
      }
      continue;
    }
    buf += (buf ? " " : "") + s;
  }
  push();
  return out;
}

/** הקולות המובנים של Gemini TTS. המודל קורא כל טקסט שנשלח אליו — לכן שולחים רק את הטקסט, בלי הוראות. */
export const VOICES: { id: string; label: string }[] = [
  { id: "Zephyr", label: "Zephyr — בהיר" },
  { id: "Puck", label: "Puck — נמרץ" },
  { id: "Kore", label: "Kore — נחרץ" },
  { id: "Charon", label: "Charon — ענייני" },
  { id: "Fenrir", label: "Fenrir — נלהב" },
  { id: "Leda", label: "Leda — צעיר" },
  { id: "Orus", label: "Orus — יציב" },
  { id: "Aoede", label: "Aoede — קליל" },
  { id: "Callirrhoe", label: "Callirrhoe — רגוע" },
  { id: "Enceladus", label: "Enceladus — נושם" },
  { id: "Iapetus", label: "Iapetus — ברור" },
  { id: "Umbriel", label: "Umbriel — רגוע" },
  { id: "Algieba", label: "Algieba — חלק" },
  { id: "Despina", label: "Despina — חלק" },
  { id: "Erinome", label: "Erinome — ברור" },
  { id: "Algenib", label: "Algenib — מחוספס" },
  { id: "Rasalgethi", label: "Rasalgethi — מלומד" },
  { id: "Laomedeia", label: "Laomedeia — קליל" },
  { id: "Achernar", label: "Achernar — רך" },
  { id: "Alnilam", label: "Alnilam — יציב" },
  { id: "Schedar", label: "Schedar — שווה" },
  { id: "Gacrux", label: "Gacrux — בוגר" },
  { id: "Pulcherrima", label: "Pulcherrima — ישיר" },
  { id: "Achird", label: "Achird — ידידותי" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi — יומיומי" },
  { id: "Vindemiatrix", label: "Vindemiatrix — עדין" },
  { id: "Sadachbia", label: "Sadachbia — תוסס" },
  { id: "Sadaltager", label: "Sadaltager — בקיא" },
  { id: "Sulafat", label: "Sulafat — חם" },
];
export const TTS_VERSION = "v3"; // משתנה כשאופן היצירה משתנה — כדי לא להגיש שמע ישן ושגוי

/** טקסט → PCM 16 ביט מונו 24kHz (ב-Buffer). נשלח הטקסט בלבד — כל מילה נוספת תוקרא. */
/** Gemini מחזיר קובץ WAV שלם (RIFF). לוקחים רק את חלק הצליל, ומתאימים ל-24kHz אם צריך. */
export function wavToPcm(buf: Buffer, targetRate = SAMPLE_RATE): Buffer {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return buf; // לא WAV — שמע גולמי
  let pos = 12;
  let rate = targetRate;
  let channels = 1;
  let bits = 16;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(start + 2);
      rate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buf.subarray(start, Math.min(buf.length, start + size));
      break;
    }
    pos = start + size + (size % 2);
  }
  if (!data) return buf;
  if (bits !== 16) throw new Error("WAV לא נתמך: " + bits + " ביט");
  // לערוץ אחד
  if (channels > 1) {
    const frames = Math.floor(data.length / (2 * channels));
    const mono = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) mono.writeInt16LE(data.readInt16LE(i * 2 * channels), i * 2);
    data = mono;
  }
  if (rate === targetRate) return Buffer.from(data);
  // התאמת קצב דגימה פשוטה (ליניארית)
  const n = Math.floor(data.length / 2);
  const outN = Math.floor((n * targetRate) / rate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * rate) / targetRate;
    const k = Math.floor(x);
    const a = data.readInt16LE(Math.min(k, n - 1) * 2);
    const b = data.readInt16LE(Math.min(k + 1, n - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (x - k)), i * 2);
  }
  return out;
}

async function ttsChunk(part: string, voice: string): Promise<Buffer> {
  const res = await ai().models.generateContent({
    model: MODELS.tts,
    contents: part,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const parts = (res.candidates?.[0]?.content?.parts ?? []).filter((p) => p.inlineData?.data);
  if (!parts.length) throw new Error("Gemini TTS לא החזיר שמע (" + JSON.stringify(res.candidates?.[0]?.finishReason) + ")");
  return Buffer.concat(parts.map((p) => wavToPcm(Buffer.from(p.inlineData!.data!, "base64"))));
}

export async function tts(text: string, lang: string, voice = VOICE): Promise<Buffer> {
  void lang; // Gemini מזהה את השפה לבד
  const clean = cleanForTts(text);
  if (!clean) return fakePcm(0.5);
  if (MOCK) {
    const secs = Math.max(2, Math.min(12, text.length / 150));
    return fakePcm(secs);
  }
  const bufs: Buffer[] = [];
  for (const part of splitForTts(clean)) {
    try {
      bufs.push(await ttsChunk(part, voice));
    } catch (e) {
      // ניסיון שני: בלי ניקוד ובחתיכות קטנות יותר (טקסט מנוקד כבד למנוע)
      const plain = stripNiqqud(part);
      const smaller = splitForTts(plain, 1500);
      try {
        for (const sp of smaller) bufs.push(await ttsChunk(sp, voice));
      } catch {
        throw e;
      }
    }
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

let modelsMemo: { at: number; names: string[] } | null = null;
async function cachedModels(): Promise<string[]> {
  if (modelsMemo && Date.now() - modelsMemo.at < 10 * 60 * 1000) return modelsMemo.names;
  const names = await listModels();
  modelsMemo = { at: Date.now(), names };
  return names;
}

/** בוחר את מודל השיחה החיה: מה שהוגדר, ואם לא — הראשון מהרשימה שקיים בחשבון. */
export async function pickLiveModel(): Promise<string> {
  if (MODELS.live) return MODELS.live;
  if (MOCK) return LIVE_CANDIDATES[0];
  const names = await cachedModels();
  for (const c of LIVE_CANDIDATES) if (names.some((n) => n === c || n.endsWith("/" + c))) return c;
  return LIVE_CANDIDATES[1];
}

/** מפתח זמני לשיחה חיה מהדפדפן — נעול למודל ולהוראות שנקבעו כאן; המפתח האמיתי נשאר בשרת. */
export interface LiveTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export async function createLiveToken(systemInstruction: string, voice = VOICE, tools: LiveTool[] = []): Promise<{ token: string; model: string; expiresAt: string }> {
  const model = await pickLiveModel();
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  if (MOCK) return { token: "mock-token", model, expiresAt: expireTime };
  const alpha = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1alpha" } });
  const tok = await alpha.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      liveConnectConstraints: {
        model,
        config: {
          responseModalities: ["AUDIO" as never],
          systemInstruction,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(tools.length
            ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] }
            : {}),
        },
      },
    },
  });
  if (!tok.name) throw new Error("לא התקבל מפתח זמני לשיחה");
  return { token: tok.name, model, expiresAt: expireTime };
}

export async function listModels(): Promise<string[]> {
  if (MOCK) return ["(mock)"];
  const names: string[] = [];
  const pager = await ai().models.list({ config: { pageSize: 100 } });
  for await (const m of pager) names.push(m.name ?? "");
  return names;
}
