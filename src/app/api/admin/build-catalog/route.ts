// בונה את קטלוג גוטנברג המקומי (להריץ פעם אחת, ואחר כך פעם בכמה חודשים).
import { ok, fail, authorized } from "@/lib/api";
import { buildCatalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const t0 = Date.now();
    const r = await buildCatalog();
    return ok({ ...r, ms: Date.now() - t0 });
  } catch (e) {
    return fail(e);
  }
}
export const GET = POST;
