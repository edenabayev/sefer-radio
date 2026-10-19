// רץ כל דקה ב-Vercel: ממשיך להכין ספרים ששמעו לאחרונה — גם כשהאפליקציה סגורה.
import { ok, fail } from "@/lib/api";
import { listBooks, getProgress } from "@/lib/books";
import { prepare } from "@/lib/prepare";
import { extractStep } from "@/lib/books";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Kokoro על המעבד: כ-3 דקות לקטע אנגלי

function isCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return (req.headers.get("user-agent") || "").startsWith("vercel-cron");
}

export async function GET(req: Request) {
  if (!isCron(req)) return fail("unauthorized", 401);
  try {
    const start = Date.now();
    const budget = 600_000;
    const books = await listBooks();
    const withProgress = await Promise.all(books.map(async (b) => ({ b, p: await getProgress(b.id) })));
    const dayAgo = Date.now() - 3 * 24 * 3600 * 1000;
    // רק ספרים שהתחילו להאזין להם (▶ ראשון) ושנגעו בהם בשלושת הימים האחרונים — העלאה לבדה לא מתחילה כלום
    const active = withProgress
      .filter(({ p }) => !!p.startedAt && !!p.updatedAt && new Date(p.updatedAt).getTime() > dayAgo)
      .sort((x, y) => (x.p.updatedAt || x.b.createdAt) < (y.p.updatedAt || y.b.createdAt) ? 1 : -1);
    const done: Record<string, number> = {};
    // קריאת PDF ברקע: ספר שהועלה או נשמע ב-3 הימים האחרונים ועוד לא נקרא עד הסוף (זול — סנטים לספר)
    const reading = withProgress.filter(({ b, p }) => b.extraction?.status === "pending" && ((p.updatedAt && new Date(p.updatedAt).getTime() > dayAgo) || new Date(b.createdAt).getTime() > dayAgo));
    for (const { b } of reading) {
      let pages = 0;
      while (budget - (Date.now() - start) > 120_000) {
        const r = await extractStep(b.id).catch((e) => {
          console.warn("cron extract", b.id, (e as Error).message);
          return null;
        });
        if (!r || r.busy || r.book.extraction?.status !== "pending") break;
        pages += 25;
      }
      done["read:" + b.id] = pages;
    }
    for (const { b } of active) {
      const left = budget - (Date.now() - start);
      if (left < 30_000) break;
      try {
        const r = await prepare(b.id, { budgetMs: left });
        done[b.id] = r.generated;
      } catch (e) {
        console.warn("cron prepare", b.id, (e as Error).message);
        done[b.id] = -1;
      }
    }
    return ok({ ms: Date.now() - start, done });
  } catch (e) {
    return fail(e);
  }
}
