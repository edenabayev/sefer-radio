"use client";
// דף השוואת קולות: אותה פסקה בכמה מנועים, להאזנה בטלפון.
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Sample {
  id: string;
  label: string;
  note: string;
  url?: string;
  error?: string;
  seconds?: number;
}

export default function Compare() {
  const [data, setData] = useState<{ text: string; at: string; samples: Sample[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ text: string; at: string; samples: Sample[] }>("/api/admin/tts-compare").then(setData).catch((e) => setErr(e.message));
  }, []);
  return (
    <main className="page" dir="rtl">
      <h1>השוואת קולות בעברית</h1>
      {err && <p className="err">{err}</p>}
      {!data && !err && <p className="muted">טוען…</p>}
      {data && (
        <>
          <p className="muted small">אותה פסקה, בכל המנועים. תקשיב ותגיד מה עובד לך.</p>
          {data.samples.map((s) => (
            <div key={s.id} className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>{s.label}</div>
              <div className="muted small" style={{ margin: "4px 0 8px" }}>{s.note}</div>
              {s.url ? <audio controls preload="none" src={s.url} style={{ width: "100%" }} /> : <div className="err small">לא הצליח: {s.error}</div>}
            </div>
          ))}
          <details className="muted small">
            <summary>הטקסט</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{data.text}</p>
          </details>
        </>
      )}
    </main>
  );
}
