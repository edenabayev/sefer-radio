import { ok, fail, authorized } from "@/lib/api";
import { extractStep, toMeta } from "@/lib/books";

export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const book = await extractStep(id);
    return ok(toMeta(book));
  } catch (e) {
    return fail(e);
  }
}
