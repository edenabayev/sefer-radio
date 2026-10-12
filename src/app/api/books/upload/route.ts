// העלאת קובץ. עם Vercel Blob — הדפדפן מעלה ישירות ל-Blob (עוקף את מגבלת 4.5MB של הפונקציות),
// והנתיב הזה רק מנפיק אישור. במצב מקומי — מקבל את הקובץ עצמו.
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { ok, fail, authorized } from "@/lib/api";
import { storageMode, writeBytes } from "@/lib/storage";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      if (storageMode !== "local") return fail("במצב Blob מעלים ישירות מהדפדפן", 400);
      const form = await req.formData();
      const f = form.get("file") as File | null;
      if (!f) return fail("חסר קובץ", 400);
      const bytes = Buffer.from(await f.arrayBuffer());
      const p = `uploads/${Date.now()}-${f.name}`;
      const url = await writeBytes(p, bytes, f.type || "application/octet-stream");
      return ok({ url, pathname: p, filename: f.name });
    }
    const body = (await req.json()) as HandleUploadBody;
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => ({
        allowedContentTypes: ["application/pdf", "application/epub+zip", "text/plain", "application/octet-stream", "text/markdown"],
        maximumSizeInBytes: 200 * 1024 * 1024,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ pathname }),
      }),
      onUploadCompleted: async () => {},
    });
    return ok(json);
  } catch (e) {
    return fail(e);
  }
}
