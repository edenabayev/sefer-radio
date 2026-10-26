// "מה פספסתי": סיכום בעברית — של הלילה (אם ההאזנה האחרונה נגמרה בשעון שינה) או של מה ששמעת לאחרונה.
import { ok, fail, authorized } from "@/lib/api";
import { getBook, getProgress } from "@/lib/books";
import { missed } from "@/lib/sleep";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await getBook(id);
    if (!book) return fail("אין ספר כזה", 404);
    return ok(await missed(book, await getProgress(id)));
  } catch (e) {
    return fail(e);
  }
}
