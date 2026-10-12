import { ok, fail, authorized } from "@/lib/api";
import { toMeta } from "@/lib/books";
import { createFromArchive } from "@/lib/sources";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const { identifier } = (await req.json()) as { identifier: string };
    return ok(toMeta(await createFromArchive(identifier)));
  } catch (e) {
    return fail(e);
  }
}
