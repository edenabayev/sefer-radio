// אחסון: Vercel Blob כשיש מפתח, אחרת תיקייה מקומית (לבדיקות).
// כל נתיב הוא קבוע ודטרמיניסטי — זה מה שמאפשר "לבדוק אם התא מלא לפני שמייצרים".
import { put, get, list, del } from "@vercel/blob";
import { promises as fs } from "fs";
import path from "path";

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const LOCAL_ROOT = path.join(process.cwd(), ".data");

function localPath(p: string) {
  return path.join(LOCAL_ROOT, p);
}

export async function readBytes(p: string): Promise<Buffer | null> {
  if (useBlob) {
    const r = await get(p, { access: "public", useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    const ab = await new Response(r.stream).arrayBuffer();
    return Buffer.from(ab);
  }
  try {
    return await fs.readFile(localPath(p));
  } catch {
    return null;
  }
}

export async function readText(p: string): Promise<string | null> {
  const b = await readBytes(p);
  return b ? b.toString("utf8") : null;
}

export async function readJSON<T>(p: string): Promise<T | null> {
  const t = await readText(p);
  if (t == null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/** כותב קובץ ומחזיר כתובת ציבורית (ב-Blob) או כתובת יחסית (מקומית). */
export async function writeBytes(
  p: string,
  data: Buffer | Uint8Array | string,
  contentType: string,
): Promise<string> {
  if (useBlob) {
    const body = typeof data === "string" ? data : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = await put(p, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return r.url;
  }
  const fp = localPath(p);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, data);
  return `/api/local-file?p=${encodeURIComponent(p)}`;
}

export async function writeJSON(p: string, obj: unknown): Promise<string> {
  return writeBytes(p, JSON.stringify(obj), "application/json");
}

export async function exists(p: string): Promise<string | null> {
  if (useBlob) {
    const r = await list({ prefix: p, limit: 1 });
    const b = r.blobs.find((x) => x.pathname === p);
    return b ? b.url : null;
  }
  try {
    await fs.access(localPath(p));
    return `/api/local-file?p=${encodeURIComponent(p)}`;
  } catch {
    return null;
  }
}

export async function listPaths(prefix: string): Promise<string[]> {
  if (useBlob) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      out.push(...r.blobs.map((b) => b.pathname));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  const root = localPath(prefix);
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: import("fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(LOCAL_ROOT, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out;
}

export async function remove(p: string) {
  if (useBlob) {
    const url = await exists(p);
    if (url) await del(url);
    return;
  }
  try {
    await fs.unlink(localPath(p));
  } catch {
    /* ignore */
  }
}

export const storageMode = useBlob ? "blob" : "local";

export interface FileInfo {
  path: string;
  size: number;
  url: string;
}

/** רשימת קבצים עם גודל — לבניית זרם רציף (הגודל קובע את משך השמע ב-MP3 בקצב קבוע). */
export async function listFiles(prefix: string): Promise<FileInfo[]> {
  if (useBlob) {
    const out: FileInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      out.push(...r.blobs.map((b) => ({ path: b.pathname, size: b.size, url: b.url })));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  const paths = await listPaths(prefix);
  const out: FileInfo[] = [];
  for (const p of paths) {
    try {
      const st = await fs.stat(localPath(p));
      out.push({ path: p, size: st.size, url: `/api/local-file?p=${encodeURIComponent(p)}` });
    } catch {
      /* נעלם בינתיים */
    }
  }
  return out;
}

/** חלק מקובץ (בייטים start עד end כולל) — לזרם עם Range. */
export async function readRange(info: FileInfo, start: number, end: number): Promise<Buffer> {
  if (useBlob) {
    const r = await fetch(info.url, { headers: { Range: `bytes=${start}-${end}` }, cache: "no-store" });
    if (!r.ok && r.status !== 206) throw new Error("קריאת חלק מקובץ נכשלה: " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    // אם השרת התעלם מה-Range והחזיר הכול — חותכים בעצמנו
    return r.status === 206 ? buf : buf.subarray(start, end + 1);
  }
  const fh = await fs.open(localPath(info.path), "r");
  try {
    const len = end - start + 1;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
