import { ok, fail, authorized } from "@/lib/api";
import { createFromGutenberg, toMeta } from "@/lib/books";

export const maxDuration = 120;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { gid, title, author, lang } = (await req.json()) as { gid: number; title?: string; author?: string; lang?: string };
    const book = await createFromGutenberg(Number(gid), { title, author, lang });
    return ok(toMeta(book));
  } catch (e) {
    return fail(e);
  }
}
