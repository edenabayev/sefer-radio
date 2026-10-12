import { ok, fail, authorized } from "@/lib/api";
import { deleteBook, getBook } from "@/lib/books";


export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  const { id } = await ctx.params;
  const book = await getBook(id);
  if (!book) return fail("אין ספר כזה", 404);
  // לא שולחים את הטקסט הגולמי של החילוץ ללקוח — רק מה שצריך לנגן
  const { extraction, ...rest } = book;
  return ok({ ...rest, extraction: extraction ? { status: extraction.status, totalPages: extraction.totalPages, nextPage: extraction.nextPage, error: extraction.error } : undefined });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  const { id } = await ctx.params;
  await deleteBook(id);
  return ok({ ok: true });
}
