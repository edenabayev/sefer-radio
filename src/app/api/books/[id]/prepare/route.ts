import { ok, fail, authorized } from "@/lib/api";
import { prepare } from "@/lib/prepare";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { from?: number; voice?: string; budgetMs?: number };
    return ok(await prepare(id, { from: body.from, voice: body.voice, budgetMs: Math.min(body.budgetMs ?? 240_000, 270_000) }));
  } catch (e) {
    return fail(e);
  }
}
