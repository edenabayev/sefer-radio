import { ok, fail, authorized } from "@/lib/api";
import { rebuildBook, toMeta } from "@/lib/books";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    return ok(toMeta(await rebuildBook(id)));
  } catch (e) {
    return fail(e);
  }
}
