// מעבר kk2 → kk3 (26.10): הקלטות אנגלית שהטקסט המוקרא שלהן לא השתנה מועתקות כמו שהן; קטעים שהייתה בהם
// כותרת רצה ("The Catcher in the Rye" באמצע הסיפור) או פסקה שנשברה באמצע משפט — לא, וההכנה ברקע יוצרת אותם מחדש.
import { list, copy } from "@vercel/blob";
import { ok, fail, authorized } from "@/lib/api";
import { getBook, type Book } from "@/lib/books";
import { cleanSectionText } from "@/lib/text";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FROM = "kk2";
const TO = "kk3";
const norm = (x: string) => x.replace(/\s*\n\s*\n\s*/g, "\n\n").replace(/[ \t]+/g, " ").trim();

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return ok({ skipped: "local" });
    const books = new Map<string, Book | null>();
    let copied = 0;
    let regenerate = 0;
    const changed: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix: "books/", cursor, limit: 1000 });
      for (const b of r.blobs) {
        const m = b.pathname.match(/^books\/([^/]+)\/audio\/en\/([^/]+)-kk2\/(\d+)\.mp3$/);
        if (!m) continue;
        const [, id, voice, n] = m;
        if (!books.has(id)) books.set(id, await getBook(id));
        const book = books.get(id);
        const sec = book?.sections[Number(n)];
        if (!book || !sec) continue;
        if (norm(cleanSectionText(book, sec.i)) !== norm(sec.text)) {
          regenerate++;
          changed.push(`${id}:${n}`);
          continue;
        }
        await copy(b.url, `books/${id}/audio/en/${voice}-${TO}/${n}.mp3`, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "audio/mpeg" });
        copied++;
      }
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return ok({ from: FROM, to: TO, copied, regenerate, changed: changed.slice(0, 200) });
  } catch (e) {
    return fail(e);
  }
}
