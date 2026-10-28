// מתרגם גיבוי: Google Translate (מנוע התרגום הרגיל של גוגל — לא Gemini, ובלי מסנן תוכן שמסרב).
// משמש רק כש-Gemini מסרב לתרגם קטע. אותו מפתח כמו Gemini (בפרויקט שבו Cloud Translation API מופעל),
// או מפתח נפרד ב-GOOGLE_TRANSLATE_KEY. המפתח נשלח בכותרת, לא בכתובת.
export async function googleTranslate(paragraphs: string[], target = "he", source?: string): Promise<string[]> {
  const key = process.env.GOOGLE_TRANSLATE_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("אין מפתח ל-Google Translate");
  const out: string[] = [];
  // עד 100 פסקאות ו-~25 אלף תווים לבקשה
  for (let start = 0; start < paragraphs.length; ) {
    const batch: string[] = [];
    let chars = 0;
    while (start < paragraphs.length && batch.length < 100 && (batch.length === 0 || chars + paragraphs[start].length < 25000)) {
      chars += paragraphs[start].length;
      batch.push(paragraphs[start++]);
    }
    const res = await fetch("https://translation.googleapis.com/language/translate/v2", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ q: batch, target, format: "text", ...(source ? { source } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json().catch(() => null)) as { data?: { translations?: { translatedText: string }[] }; error?: { message?: string } } | null;
    if (!res.ok || !j?.data?.translations) throw new Error("Google Translate: " + (j?.error?.message || `HTTP ${res.status}`));
    out.push(...j.data.translations.map((t) => t.translatedText));
  }
  return out;
}
