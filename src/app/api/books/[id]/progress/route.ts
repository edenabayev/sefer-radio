import { ok, fail, authorized } from "@/lib/api";
import { getProgress, setProgress } from "@/lib/books";


export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  const { id } = await ctx.params;
  return ok(await getProgress(id));
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    return ok(await setProgress(id, body));
  } catch (e) {
    return fail(e);
  }
}
