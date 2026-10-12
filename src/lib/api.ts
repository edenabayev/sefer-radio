import { NextResponse } from "next/server";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(e: unknown, status = 500) {
  const message = e instanceof Error ? e.message : String(e);
  console.error("[api]", message, e instanceof Error ? e.stack : "");
  return NextResponse.json({ error: message }, { status });
}

/** הגנה פשוטה: אם הוגדרה סיסמה, כל קריאה ל-API צריכה אותה (ב-Cookie או בכותרת). */
export function authorized(req: Request): boolean {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  const h = req.headers.get("x-app-password");
  if (h === pw) return true;
  const cookie = req.headers.get("cookie") || "";
  return cookie.split(/;\s*/).some((c) => c === `app_pw=${encodeURIComponent(pw)}`);
}
