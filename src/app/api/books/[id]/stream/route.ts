// הזרם עצמו: MP3 רציף עם תמיכה ב-Range (הדפדפן מבקש חלקים ומדלג). הכתובת מגדירה בדיוק אילו קבצים —
// לכן היא יציבה גם כשבינתיים הוכנו עוד קטעים.
import { fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { resolveStream, rangeStream, applyGen } from "@/lib/stream";
import { audioVoiceFor, langFor } from "@/lib/stream-params";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request, ctx: { params: Promise<{ id: string }> }, head: boolean) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const sp = new URL(req.url).searchParams;
    // הדור שהיה כשהזרם הוגדר (ולא מה שקורה עכשיו) — הזרם יציב
    if (sp.has("gen")) applyGen(book, sp.get("gen"));
    const progress = await getProgress(id);
    const lang = langFor(book, sp.get("lang"), progress);
    const voice = audioVoiceFor(sp.get("voice"), lang, progress);
    const from = Number(sp.get("from"));
    const upto = Number(sp.get("upto"));
    if (!Number.isInteger(from) || !Number.isInteger(upto) || upto < from) return fail("טווח לא תקין", 400);
    const qs = (sp.get("qs") || "").split(",").filter(Boolean).map(Number);
    const { parts, total } = await resolveStream(book, from, upto, qs, lang, voice);
    const range = req.headers.get("range");
    let start = 0;
    let end = total - 1;
    let status = 200;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        if (m[1]) start = Number(m[1]);
        if (m[2]) end = Math.min(total - 1, Number(m[2]));
        if (!m[1] && m[2]) {
          start = Math.max(0, total - Number(m[2]));
          end = total - 1;
        }
        if (start > end || start >= total) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
        status = 206;
      }
    }
    const headers: Record<string, string> = {
      "Content-Type": "audio/mpeg",
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Cache-Control": "private, max-age=3600",
      "X-Stream-Total": String(total),
    };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    if (head) return new Response(null, { status, headers });
    return new Response(rangeStream(parts, start, end), { status, headers });
  } catch (e) {
    return fail(e);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, false);
}
export async function HEAD(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, true);
}
