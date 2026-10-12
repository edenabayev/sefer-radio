// הגשת קבצים במצב מקומי בלבד (בלי Vercel Blob). ב-Vercel הקבצים מוגשים מכתובת ה-Blob הציבורית.
import { readBytes, storageMode } from "@/lib/storage";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (storageMode !== "local") return new Response("not found", { status: 404 });
  const p = new URL(req.url).searchParams.get("p") || "";
  if (!p || p.includes("..")) return new Response("bad path", { status: 400 });
  const b = await readBytes(p);
  if (!b) return new Response("not found", { status: 404 });
  const type = p.endsWith(".mp3") ? "audio/mpeg" : p.endsWith(".json") ? "application/json" : p.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
  const range = req.headers.get("range");
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1]) : 0;
    const end = m && m[2] ? Math.min(parseInt(m[2]), b.length - 1) : b.length - 1;
    return new Response(new Uint8Array(b.subarray(start, end + 1)), {
      status: 206,
      headers: { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${b.length}`, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(b), { headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(b.length) } });
}
