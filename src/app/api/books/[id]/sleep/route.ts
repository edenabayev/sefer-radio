// שעון שינה: GET — האם יש "לילה" פתוח ואילו פסקאות התנגנו בו; POST — התחלה / עצירה / ביטול / סגירה.
import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { latestSession, sessionState, nightParagraphs, startSession, markSession } from "@/lib/sleep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const progress = await getProgress(id);
    const state = sessionState(await latestSession(id), progress);
    const paragraphs = state.pending && state.session && state.end ? await nightParagraphs(book, state.session, state.end) : [];
    return ok({ ...state, paragraphs });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const b = (await req.json().catch(() => ({}))) as {
      action?: string;
      sid?: string;
      section?: number;
      offset?: number;
      lang?: "he" | "orig";
      voice?: string;
      rate?: number;
      minutes?: number | null;
    };
    if (b.action === "start") {
      const s = await startSession(id, {
        section: Math.max(0, Math.floor(b.section ?? 0)),
        offset: Math.max(0, b.offset ?? 0),
        lang: b.lang === "orig" ? "orig" : "he",
        voice: String(b.voice || ""),
        rate: Number(b.rate) > 0 ? Number(b.rate) : 1,
        minutes: b.minutes == null ? null : Math.max(1, Math.min(180, Math.round(Number(b.minutes)))),
      });
      return ok({ session: s });
    }
    if ((b.action === "fired" || b.action === "cancel" || b.action === "done") && b.sid) {
      const pos = b.action === "fired" ? { section: Math.max(0, Math.floor(b.section ?? 0)), offset: Math.max(0, b.offset ?? 0) } : undefined;
      await markSession(id, b.sid, b.action, pos);
      return ok({ ok: true });
    }
    return fail("פעולה לא מוכרת", 400);
  } catch (e) {
    return fail(e);
  }
}
