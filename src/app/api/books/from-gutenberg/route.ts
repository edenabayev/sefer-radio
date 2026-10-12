import { ok, fail, authorized } from "@/lib/api";
import { createFromGutenberg, toMeta } from "@/lib/books";

export const maxDuration = 120;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { gid } = (await req.json()) as { gid: number };
    const book = await createFromGutenberg(Number(gid));
    return ok(toMeta(book));
  } catch (e) {
    return fail(e);
  }
}
