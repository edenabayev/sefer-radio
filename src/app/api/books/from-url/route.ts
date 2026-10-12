import { ok, fail, authorized } from "@/lib/api";
import { toMeta } from "@/lib/books";
import { createFromUrl } from "@/lib/sources";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { url } = (await req.json()) as { url: string };
    return ok(toMeta(await createFromUrl(url)));
  } catch (e) {
    return fail(e);
  }
}
