import { ok, fail, authorized } from "@/lib/api";
import { searchAll } from "@/lib/sources";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  const q = new URL(req.url).searchParams.get("q")?.trim() || "";
  if (!q) return ok({ available: [] });
  try {
    return ok(await searchAll(q));
  } catch (e) {
    return fail(e);
  }
}
