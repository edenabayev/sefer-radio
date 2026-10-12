"use client";
// הספרייה: כרטיס "המשך", תיבת חיפוש אחת (גוטנברג + ארכיון האינטרנט + רשומה מ-Open Library),
// ותפריט הוספה קבוע: קובץ / קישור.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { api, ApiError, getPassword, setPassword, type BookMeta } from "@/lib/client";

interface Hit {
  source: "gutenberg" | "archive";
  id: string;
  title: string;
  author?: string;
  year?: number;
  lang?: string;
  note?: string;
}
interface Rec {
  title: string;
  author?: string;
  year?: number;
  coverUrl?: string;
  access: "public" | "borrowable" | "printdisabled" | "no_ebook" | "unknown";
}

export default function Library() {
  const router = useRouter();
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState("");
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ available: Hit[]; record?: Rec } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [link, setLink] = useState("");
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
      setResult(await api(`/api/books/search?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function add(h: Hit) {
    setErr("");
    setBusy("add" + h.id);
    try {
      const b =
        h.source === "gutenberg"
          ? await api<BookMeta>("/api/books/from-gutenberg", { method: "POST", body: JSON.stringify({ gid: Number(h.id), title: h.title, author: h.author, lang: h.lang }) })
          : await api<BookMeta>("/api/books/from-archive", { method: "POST", body: JSON.stringify({ identifier: h.id }) });
      router.push(`/book/${b.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy("");
    }
  }

  async function addLink() {
    if (!link.trim()) return;
    setErr("");
    setBusy("link");
    try {
      const b = await api<BookMeta>("/api/books/from-url", { method: "POST", body: JSON.stringify({ url: link.trim() }) });
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
      const probe = await api<{ storage: string }>("/api/health");
      let url: string;
      let pathname: string | undefined;
      if (probe.storage === "blob") {
        const r = await upload(`uploads/${f.name}`, f, { access: "public", handleUploadUrl: "/api/books/upload", headers: { "x-app-password": getPassword() }, contentType: f.type || "application/octet-stream" });
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
        <form onSubmit={(e) => { e.preventDefault(); setPassword(pw); load(); }}>
          <input type="password" placeholder="סיסמה" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <div style={{ height: 10 }} />
          <button className="primary" type="submit" style={{ width: "100%" }}>כניסה</button>
        </form>
      </main>
    );
  }

  const current = books?.find((b) => b.progress) ?? null;
  const pct = (b: BookMeta) => (b.progress && b.sections ? Math.round((b.progress.section / b.sections) * 100) : 0);

  return (
    <main className="page">
      <div className="title">רדיו ספרים</div>

      {current && (
        <div className="card clickable continueCard" onClick={() => router.push(`/book/${current.id}`)}>
          <div className="muted small">המשך להאזין</div>
          <div className="big" dir="auto">{current.title}</div>
          <div className="muted small" dir="auto">{current.author}{current.author ? " · " : ""}{pct(current)}%</div>
          <div className="bar"><div style={{ width: `${pct(current)}%` }} /></div>
        </div>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <input type="search" placeholder="שם ספר או מחבר" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" />
        <button className="primary" type="submit" disabled={busy === "search"}>{busy === "search" ? <span className="spinner" /> : "חפש"}</button>
      </form>
      <div style={{ height: 8 }} />
      <button className="ghost" style={{ width: "100%" }} onClick={() => setAddOpen((o) => !o)}>
        + הוסף ספר משלי (קובץ או קישור)
      </button>
      {addOpen && (
        <div className="card">
          <input ref={fileRef} type="file" accept=".pdf,.epub,.txt,.md,application/pdf,application/epub+zip,text/plain" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
          <button className="primary" style={{ width: "100%" }} onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
            {busy === "upload" ? <><span className="spinner" /> מעלה…</> : "בחר קובץ מהטלפון (PDF / EPUB / טקסט)"}
          </button>
          <div style={{ height: 10 }} />
          <form className="row" onSubmit={(e) => { e.preventDefault(); addLink(); }}>
            <input type="url" placeholder="קישור ישיר לקובץ PDF / EPUB" value={link} onChange={(e) => setLink(e.target.value)} dir="ltr" />
            <button className="ghost" type="submit" disabled={busy === "link"}>{busy === "link" ? <span className="spinner" /> : "הוסף"}</button>
          </form>
          <p className="muted small">ספר באנגלית מתורגם לעברית תוך כדי. ספר בעברית מוקרא ישירות. קובץ סרוק נקרא עמוד-עמוד.</p>
        </div>
      )}

      {err && <p className="err">{err}</p>}

      {result && (
        <>
          <h2>תוצאות</h2>
          {result.available.length === 0 && !result.record && <p className="muted">לא נמצא טקסט חופשי בשם הזה. אם יש לך את הספר כקובץ או כקישור — הוסף אותו למעלה.</p>}
          {result.available.map((h) => (
            <div key={h.source + h.id} className="card row">
              <div className="grow">
                <div dir="auto">{h.title}</div>
                <div className="muted small" dir="auto">
                  {h.author}{h.year ? ` · ${h.year}` : ""}{h.lang ? ` · ${h.lang}` : ""}{h.note ? ` · ${h.note}` : " · גוטנברג"}
                </div>
              </div>
              <button className="primary" onClick={() => add(h)} disabled={!!busy}>{busy === "add" + h.id ? <span className="spinner" /> : "הוסף"}</button>
            </div>
          ))}
          {result.record && (
            <div className="card row">
              {result.record.coverUrl && <img src={result.record.coverUrl} alt="" style={{ width: 48, borderRadius: 6 }} />}
              <div className="grow">
                <div dir="auto">{result.record.title}</div>
                <div className="muted small" dir="auto">{result.record.author}{result.record.year ? ` · ${result.record.year}` : ""}</div>
                <div className="small" style={{ marginTop: 6 }}>
                  {result.record.access === "public"
                    ? "קיים כטקסט חופשי בספרייה הפתוחה, אבל לא הצלחנו למשוך אותו אוטומטית — הוסף מקישור."
                    : "הספר הזה מוגן בזכויות יוצרים, ולכן אין מקור חוקי שאפשר למשוך ממנו לפי שם. אם הספר אצלך כקובץ — הוסף אותו דרך \"הוסף ספר משלי\" ונקריא אותו."}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <h2>הספרים שלי</h2>
      {books === null && <p className="muted">טוען…</p>}
      {books && books.length === 0 && <p className="muted">עדיין אין ספרים. חפש אחד למעלה או הוסף קובץ.</p>}
      {books?.map((b) => (
        <div key={b.id} className="card clickable row" onClick={() => router.push(`/book/${b.id}`)}>
          <div className="grow">
            <div dir="auto">{b.title}</div>
            <div className="muted small" dir="auto">
              {b.author ? b.author + " · " : ""}
              {b.lang === "he" ? "עברית" : b.lang === "en" ? "אנגלית → עברית" : "נקרא…"} · {b.sections} קטעים
              {b.progress ? ` · ${pct(b)}%` : ""}
              {b.extraction?.status === "pending" && ` · נקרא: עמוד ${b.extraction.nextPage - 1}/${b.extraction.totalPages}`}
              {b.extraction?.status === "error" && " · תקלה בקריאה"}
            </div>
          </div>
          <button className="ghost" onClick={(e) => { e.stopPropagation(); removeBook(b); }} aria-label="מחק">✕</button>
        </div>
      ))}
    </main>
  );
}
