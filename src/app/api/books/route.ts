import { ok, fail, authorized } from "@/lib/api";
import { listBooks } from "@/lib/books";


export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    return ok(await listBooks());
  } catch (e) {
    return fail(e);
  }
}
