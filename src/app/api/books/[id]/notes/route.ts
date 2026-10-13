// פתקים לספר: רשימה, הוספה (ידנית מהשיחה או סיכום אוטומטי), מחיקה.
import { ok, fail, authorized } from "@/lib/api";
import { getBook } from "@/lib/books";
import { listNotes, addNote, deleteNote, summarizeConversation, type Turn } from "@/lib/conversation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    return ok({ notes: await listNotes(id) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    const body = (await req.json().catch(() => ({}))) as { section?: number; title?: string; text?: string; transcript?: Turn[] };
    const section = body.section ?? 0;
    if (Array.isArray(body.transcript)) {
      const note = await summarizeConversation(book, section, body.transcript.slice(-60));
      return ok({ note });
    }
    if (!body.text?.trim()) return fail("פתק ריק", 400);
    const note = await addNote(book, { section, kind: "saved", title: (body.title || "פתק").slice(0, 120), text: body.text.slice(0, 4000) });
    return ok({ note });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const noteId = new URL(req.url).searchParams.get("note") || "";
    if (!noteId) return fail("חסר מזהה פתק", 400);
    await deleteNote(id, noteId);
    return ok({ deleted: noteId });
  } catch (e) {
    return fail(e);
  }
}
