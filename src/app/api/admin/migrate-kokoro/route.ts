// מעבר kk1 → kk2: הקלטות אנגלית שנוצרו אחרי צינור ההקראה (15.10) מועתקות כמו שהן; הישנות לא — וההכנה ברקע יוצרת אותן מחדש.
import { list, copy } from "@vercel/blob";
import { ok, fail, authorized } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CUTOFF = new Date("2026-10-15T07:40:00Z").getTime();

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return ok({ skipped: "local" });
    const copied: string[] = [];
    let old = 0;
    let cursor: string | undefined;
    do {
      const r = await list({ prefix: "books/", cursor, limit: 1000 });
      for (const b of r.blobs) {
        const m = b.pathname.match(/^(books\/[^/]+\/audio\/en\/[^/]+)-kk1\/(\d+\.mp3)$/);
        if (!m) continue;
        if (new Date(b.uploadedAt).getTime() < CUTOFF) {
          old++;
          continue;
        }
        const to = `${m[1]}-kk2/${m[2]}`;
        await copy(b.url, to, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "audio/mpeg" });
        copied.push(to);
      }
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return ok({ copied: copied.length, regenerate: old });
  } catch (e) {
    return fail(e);
  }
}
