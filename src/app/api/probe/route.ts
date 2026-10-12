// בדיקת גישה למקורות ספרים מהשרת (מוגן בסיסמה, רק דומיינים של גוטנברג).
import { ok, fail, authorized } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED = ["gutendex.com", "www.gutenberg.org", "gutenberg.org", "gutenberg.pglaf.org", "aleph.gutenberg.org"];

export async function GET(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  const u = new URL(req.url).searchParams.get("url") || "";
  const ua = new URL(req.url).searchParams.get("ua") || "sefer-radio (personal study app)";
  try {
    const target = new URL(u);
    if (!ALLOWED.includes(target.hostname)) return fail("domain not allowed", 400);
    const t0 = Date.now();
    const r = await fetch(target, { headers: { "User-Agent": ua, Accept: "*/*" }, redirect: "follow" });
    const text = await r.text();
    return ok({ status: r.status, ms: Date.now() - t0, finalUrl: r.url, contentType: r.headers.get("content-type"), length: text.length, head: text.slice(0, 600) });
  } catch (e) {
    return fail(e);
  }
}
