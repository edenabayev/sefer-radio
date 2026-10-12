import { ok, fail, authorized } from "@/lib/api";
import { createFromUpload, toMeta } from "@/lib/books";

export const maxDuration = 120;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { url, filename, pathname } = (await req.json()) as { url: string; filename: string; pathname?: string };
    const book = await createFromUpload(url, filename, pathname);
    return ok(toMeta(book));
  } catch (e) {
    return fail(e);
  }
}
