"use client";
// קריאות מהדפדפן לשרת, עם הסיסמה (אם הוגדרה) ושגיאות קריאות.

export function getPassword(): string {
  try {
    return localStorage.getItem("app_pw") || "";
  } catch {
    return "";
  }
}
export function setPassword(pw: string) {
  try {
    localStorage.setItem("app_pw", pw);
    document.cookie = `app_pw=${encodeURIComponent(pw)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  const pw = getPassword();
  if (pw) headers.set("x-app-password", pw);
  if (init?.body && typeof init.body === "string") headers.set("content-type", "application/json");
  const r = await fetch(path, { ...init, headers });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!r.ok) {
    const msg = (data as { error?: string })?.error || `שגיאה ${r.status}`;
    throw new ApiError(msg, r.status);
  }
  return data as T;
}

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  lang: "he" | "en" | "other";
  sections: number;
  chapters: number;
  createdAt: string;
  extraction?: { status: "pending" | "done" | "error"; totalPages: number; nextPage: number; error?: string };
}
export interface BookFull extends Omit<BookMeta, "sections" | "chapters"> {
  chapters: { title: string; start: number; end: number }[];
  sections: { i: number; chapter: number; text: string }[];
}
export interface Progress {
  section: number;
  offset: number;
  lang: "he" | "orig";
  study: boolean;
  updatedAt: string;
}
export interface AudioResult {
  url: string;
  text: string;
  lang: string;
  cached: boolean;
}
