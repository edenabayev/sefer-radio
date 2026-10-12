"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { api, ApiError, getPassword, setPassword, type BookMeta } from "@/lib/client";

interface Hit {
  gid: number;
  title: string;
  author?: string;
  languages: string[];
  downloads: number;
  textUrl?: string;
}

export default function Library() {
  const router = useRouter();
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setBooks(await api<BookMeta[]>("/api/books"));
      setNeedPw(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedPw(true);
      else setErr(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function search() {
    if (!q.trim()) return;
    setErr("");
    setBusy("search");
    try {
      setHits(await api<Hit[]>(`/api/books/search?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function addGutenberg(h: Hit) {
    setErr("");
    setBusy("add" + h.gid);
    try {
      const b = await api<BookMeta>("/api/books/from-gutenberg", { method: "POST", body: JSON.stringify({ gid: h.gid, title: h.title, author: h.author, lang: h.languages[0] }) });
      router.push(`/book/${b.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy("");
    }
  }

  async function onFile(f: File) {
    setErr("");
    setBusy("upload");
    try {
      // ב-Vercel: העלאה ישירה ל-Blob מהדפדפן. מקומית: דרך השרת.
      const probe = await api<{ mock: boolean; storage: string }>("/api/health");
      let url: string;
      let pathname: string | undefined;
      if (probe.storage === "blob") {
        const r = await upload(`uploads/${f.name}`, f, {
          access: "public",
          handleUploadUrl: "/api/books/upload",
          headers: { "x-app-password": getPassword() },
          contentType: f.type || "application/octet-stream",
        });
        url = r.url;
        pathname = r.pathname;
      } else {
        const fd = new FormData();
        fd.append("file", f);
        const r = await api<{ url: string; pathname: string }>("/api/books/upload", { method: "POST", body: fd });
        url = r.url;
        pathname = r.pathname;
      }
      const b = await api<BookMeta>("/api/books/from-upload", { method: "POST", body: JSON.stringify({ url, filename: f.name, pathname }) });
      router.push(`/book/${b.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy("");
    }
  }

  async function removeBook(b: BookMeta) {
    if (!confirm(`למחוק את "${b.title}" מהספרייה? (כולל התרגום והשמע שנוצרו)`)) return;
    await api(`/api/books/${b.id}`, { method: "DELETE" });
    load();
  }

  if (needPw) {
    return (
      <main className="page">
        <div className="title">רדיו ספרים</div>
        <p className="muted">האפליקציה נעולה בסיסמה.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPassword(pw);
            load();
          }}
        >
          <input type="password" placeholder="סיסמה" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <div style={{ height: 10 }} />
          <button className="primary" type="submit" style={{ width: "100%" }}>
            כניסה
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="title">רדיו ספרים</div>
      <p className="muted">מחפשים ספר או מעלים קובץ — ומתחילים לשמוע.</p>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input type="search" placeholder="שם ספר או מחבר (באנגלית, מגוטנברג)" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" />
        <button className="primary" type="submit" disabled={busy === "search"}>
          {busy === "search" ? <span className="spinner" /> : "חפש"}
        </button>
      </form>

      <div style={{ height: 10 }} />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.epub,.txt,.md,application/pdf,application/epub+zip,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <button className="ghost" style={{ width: "100%" }} onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
        {busy === "upload" ? (
          <>
            <span className="spinner" /> מעלה…
          </>
        ) : (
          "העלה קובץ משלי (PDF / EPUB / טקסט, עברית או אנגלית)"
        )}
      </button>

      {err && <p className="err">{err}</p>}

      {hits && (
        <>
          <h2>תוצאות מגוטנברג</h2>
          {hits.length === 0 && <p className="muted">לא נמצא. נסה ניסוח אחר באנגלית.</p>}
          {hits.map((h) => (
            <div key={h.gid} className="card row">
              <div className="grow">
                <div dir="auto">{h.title}</div>
                <div className="muted" dir="auto">
                  {h.author}
                  {h.languages.length ? ` · ${h.languages.join(", ")}` : ""}
                  {h.downloads ? ` · ${h.downloads.toLocaleString()} הורדות` : ""}
                </div>
              </div>
              <button className="primary" onClick={() => addGutenberg(h)} disabled={!!busy || !h.textUrl}>
                {busy === "add" + h.gid ? <span className="spinner" /> : "הוסף"}
              </button>
            </div>
          ))}
        </>
      )}

      <h2>הספרים שלי</h2>
      {books === null && <p className="muted">טוען…</p>}
      {books && books.length === 0 && <p className="muted">עדיין אין ספרים. חפש אחד למעלה או העלה קובץ.</p>}
      {books?.map((b) => (
        <div key={b.id} className="card clickable row" onClick={() => router.push(`/book/${b.id}`)}>
          <div className="grow">
            <div dir="auto">{b.title}</div>
            <div className="muted" dir="auto">
              {b.author ? b.author + " · " : ""}
              {b.lang === "he" ? "עברית" : b.lang === "en" ? "אנגלית → עברית" : "שפה אחרת"} · {b.sections} קטעים
              {b.extraction?.status === "pending" && ` · נקרא: עמוד ${b.extraction.nextPage - 1}/${b.extraction.totalPages}`}
              {b.extraction?.status === "error" && " · תקלה בקריאה"}
            </div>
          </div>
          <button
            className="ghost"
            onClick={(e) => {
              e.stopPropagation();
              removeBook(b);
            }}
            aria-label="מחק"
          >
            ✕
          </button>
        </div>
      ))}
    </main>
  );
}
