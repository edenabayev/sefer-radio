"use client";
// הנגן: רכיב <audio> אחד קבוע, רשימת השמעה של "קטע → הסבר → קטע הבא", הכנה מראש של הפריטים הבאים,
// Media Session לכפתורי האוזניות ולמסך הנעילה, שאלה בקול, ושמירת המקום.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, type AudioResult, type BookFull, type Progress } from "@/lib/client";

type ItemKind = "section" | "explain";
interface Item {
  kind: ItemKind;
  i: number;
  lang: "he" | "orig";
}
interface Loaded {
  url: string;
  text: string;
}

function key(it: Item) {
  return `${it.kind}:${it.i}:${it.kind === "section" ? it.lang : "he"}`;
}

export default function Player({ id }: { id: string }) {
  const [book, setBook] = useState<BookFull | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [cur, setCur] = useState<Item | null>(null);
  const [curText, setCurText] = useState("");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState("");
  const [err, setErr] = useState("");
  const [pos, setPos] = useState({ t: 0, d: 0 });
  const [rate, setRate] = useState(1);
  const [rec, setRec] = useState(false);
  const [answer, setAnswer] = useState("");
  const [extractMsg, setExtractMsg] = useState("");

  const audioRef = useRef<HTMLAudioElement>(null);
  const cache = useRef(new Map<string, Promise<Loaded>>());
  const curRef = useRef<Item | null>(null);
  const progRef = useRef<Progress | null>(null);
  const bookRef = useRef<BookFull | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const resumeAfterAsk = useRef(false);
  const answerPlaying = useRef<{ src: string; t: number; it: Item | null } | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    curRef.current = cur;
  }, [cur]);
  useEffect(() => {
    progRef.current = prog;
  }, [prog]);
  useEffect(() => {
    bookRef.current = book;
  }, [book]);

  // ---- טעינה ראשונית ----
  useEffect(() => {
    (async () => {
      try {
        const [b, p] = await Promise.all([api<BookFull>(`/api/books/${id}`), api<Progress>(`/api/books/${id}/progress`)]);
        setBook(b);
        setProg(p);
        const lang = b.lang === "he" ? "he" : p.lang;
        setCur({ kind: "section", i: Math.min(p.section, Math.max(0, b.sections.length - 1)), lang });
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [id]);

  // ---- קריאת PDF בצעדים (רק לספרים שעוד לא נקראו עד הסוף) ----
  useEffect(() => {
    if (!book || book.extraction?.status !== "pending") return;
    let stop = false;
    (async () => {
      while (!stop) {
        const ex = bookRef.current?.extraction;
        if (!ex || ex.status !== "pending") break;
        setExtractMsg(`קורא את הקובץ… עמוד ${ex.nextPage} מתוך ${ex.totalPages}`);
        try {
          await api(`/api/books/${id}/extract-step`, { method: "POST" });
          const fresh = await api<BookFull>(`/api/books/${id}`);
          if (stop) break;
          setBook(fresh);
          if (fresh.extraction?.status === "done") setExtractMsg("");
          if (fresh.extraction?.status === "error") setExtractMsg("תקלה בקריאת הקובץ: " + fresh.extraction.error);
        } catch (e) {
          setExtractMsg("תקלה בקריאת הקובץ: " + (e as Error).message);
          break;
        }
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, book?.extraction?.status]);

  // ---- הבאת פריט (עם זיכרון) ----
  const fetchItem = useCallback(
    (it: Item): Promise<Loaded> => {
      const k = key(it);
      const hit = cache.current.get(k);
      if (hit) return hit;
      const p = (async () => {
        if (it.kind === "section") {
          const r = await api<AudioResult>(`/api/books/${id}/sections/${it.i}/audio?lang=${it.lang}`);
          return { url: r.url, text: r.text };
        }
        const r = await api<{ text: string; url: string }>(`/api/books/${id}/sections/${it.i}/explain`);
        return { url: r.url, text: r.text };
      })();
      cache.current.set(k, p);
      p.catch(() => cache.current.delete(k));
      return p;
    },
    [id],
  );

  const nextOf = useCallback((it: Item): Item | null => {
    const b = bookRef.current;
    const p = progRef.current;
    if (!b) return null;
    if (it.kind === "section" && p?.study) return { kind: "explain", i: it.i, lang: it.lang };
    if (it.i + 1 < b.sections.length) return { kind: "section", i: it.i + 1, lang: it.lang };
    return null;
  }, []);

  const prefetch = useCallback(
    (from: Item, count = 2) => {
      let it: Item | null = from;
      for (let n = 0; n < count && it; n++) {
        it = nextOf(it);
        if (it) fetchItem(it).catch(() => {});
      }
    },
    [fetchItem, nextOf],
  );

  // ---- השמעת פריט ----
  const playItem = useCallback(
    async (it: Item, startAt = 0, autoplay = true) => {
      const a = audioRef.current;
      if (!a) return;
      setErr("");
      answerPlaying.current = null;
      curRef.current = it; // מיד, לא לחכות לרינדור — כדי שבדיקת "המשתמש עבר הלאה" תהיה נכונה
      setCur(it);
      setLoading(it.kind === "explain" ? "המורה מכין הסבר…" : "מכין את הקטע…");
      try {
        const l = await fetchItem(it);
        if (curRef.current && key(curRef.current) !== key(it)) return; // המשתמש כבר עבר הלאה
        setCurText(l.text);
        a.src = l.url;
        a.playbackRate = rate;
        if (startAt > 0) {
          a.currentTime = startAt;
        }
        if (autoplay) await a.play();
        setLoading("");
        prefetch(it);
        if (it.kind === "section") {
          setProg((p) => (p ? { ...p, section: it.i } : p));
          api(`/api/books/${id}/progress`, { method: "PUT", body: JSON.stringify({ section: it.i, offset: startAt, lang: it.lang }) }).catch(() => {});
        }
      } catch (e) {
        setLoading("");
        setErr((e as Error).message || "תקלה בהשמעה");
      }
    },
    [fetchItem, id, prefetch, rate],
  );

  // ---- אירועי הנגן (מחוברים כמאפיינים על האלמנט, כך שהם שורדים כל רינדור) ----
  const onEnded = () => {
    const a = audioRef.current;
    const ans = answerPlaying.current;
    if (ans && a) {
      // נגמרה תשובת המורה — חוזרים לספר לאותו מקום
      answerPlaying.current = null;
      if (curRef.current !== ans.it) return;
      a.src = ans.src;
      a.currentTime = ans.t;
      if (resumeAfterAsk.current) a.play().catch(() => {});
      return;
    }
    const it = curRef.current;
    if (!it) return;
    const nx = nextOf(it);
    if (nx) playItem(nx);
    else setPlaying(false);
  };
  const onTime = () => {
    const a = audioRef.current;
    if (!a) return;
    setPos({ t: a.currentTime, d: isFinite(a.duration) ? a.duration : 0 });
    if ("mediaSession" in navigator && isFinite(a.duration) && a.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({ duration: a.duration, playbackRate: a.playbackRate, position: Math.min(a.currentTime, a.duration) });
      } catch {
        /* ignore */
      }
    }
    if (saveTimer.current == null) {
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const it = curRef.current;
        const a2 = audioRef.current;
        if (it?.kind === "section" && a2 && !a2.paused) {
          api(`/api/books/${id}/progress`, { method: "PUT", body: JSON.stringify({ section: it.i, offset: Math.floor(a2.currentTime) }) }).catch(() => {});
        }
      }, 15000);
    }
  };
  const onPlay = () => {
    setPlaying(true);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  };
  const onPause = () => {
    setPlaying(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    const it = curRef.current;
    const a = audioRef.current;
    if (it?.kind === "section" && a && !a.ended) api(`/api/books/${id}/progress`, { method: "PUT", body: JSON.stringify({ section: it.i, offset: Math.floor(a.currentTime) }) }).catch(() => {});
  };
  const onAudioError = () => setErr("הדפדפן לא הצליח לנגן את הקובץ");

  // ---- Media Session: מסך נעילה וכפתורי אוזניות ----
  const goNextSection = useCallback(() => {
    const it = curRef.current;
    const b = bookRef.current;
    if (!it || !b) return;
    if (it.i + 1 < b.sections.length) playItem({ kind: "section", i: it.i + 1, lang: it.lang });
  }, [playItem]);
  const goPrevSection = useCallback(() => {
    const it = curRef.current;
    const a = audioRef.current;
    if (!it || !a) return;
    if (it.kind === "section" && a.currentTime > 4) {
      a.currentTime = 0;
      return;
    }
    playItem({ kind: "section", i: Math.max(0, it.i - (it.kind === "section" ? 1 : 0)), lang: it.lang });
  }, [playItem]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !book) return;
    const ms = navigator.mediaSession;
    const chapter = cur ? book.chapters[book.sections[cur.i]?.chapter]?.title : "";
    ms.metadata = new MediaMetadata({
      title: cur?.kind === "explain" ? `הסבר · ${chapter || ""}` : chapter || book.title,
      artist: book.title + (book.author ? " · " + book.author : ""),
      album: cur ? `קטע ${cur.i + 1} מתוך ${book.sections.length}` : "",
      artwork: [{ src: "/icon.svg", sizes: "128x128", type: "image/svg+xml" }],
    });
    const a = audioRef.current!;
    const set = (action: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, h);
      } catch {
        /* לא נתמך */
      }
    };
    set("play", () => a.play());
    set("pause", () => a.pause());
    set("nexttrack", goNextSection);
    set("previoustrack", goPrevSection);
    set("seekbackward", (d) => (a.currentTime = Math.max(0, a.currentTime - (d.seekOffset || 15))));
    set("seekforward", (d) => (a.currentTime = Math.min(a.duration || 0, a.currentTime + (d.seekOffset || 15))));
    set("seekto", (d) => {
      if (d.seekTime != null) a.currentTime = d.seekTime;
    });
  }, [book, cur, goNextSection, goPrevSection]);

  // ---- פעולות ----
  async function togglePlay() {
    const a = audioRef.current;
    if (!a || !cur) return;
    if (!a.src) {
      await playItem(cur, prog?.offset || 0);
      return;
    }
    if (a.paused) await a.play();
    else a.pause();
  }

  function setLang(lang: "he" | "orig") {
    if (!cur || cur.lang === lang) return;
    setProg((p) => (p ? { ...p, lang } : p));
    api(`/api/books/${id}/progress`, { method: "PUT", body: JSON.stringify({ lang }) }).catch(() => {});
    const wasPlaying = !audioRef.current?.paused;
    playItem({ kind: "section", i: cur.i, lang }, 0, wasPlaying);
  }

  function setStudy(study: boolean) {
    setProg((p) => (p ? { ...p, study } : p));
    api(`/api/books/${id}/progress`, { method: "PUT", body: JSON.stringify({ study }) }).catch(() => {});
    if (cur && study) prefetch(cur);
  }

  function changeRate() {
    const next = rate >= 1.5 ? 1 : Math.round((rate + 0.25) * 100) / 100;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  async function jumpTo(i: number) {
    if (!cur) return;
    playItem({ kind: "section", i, lang: cur.lang });
  }

  // ---- שאלה בקול ----
  async function startRec() {
    if (!cur || rec) return;
    setErr("");
    setAnswer("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec(false);
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        if (blob.size < 2000) {
          setErr("ההקלטה קצרה מדי");
          if (resumeAfterAsk.current) audioRef.current?.play().catch(() => {});
          return;
        }
        setLoading("המורה חושב…");
        try {
          const fd = new FormData();
          fd.append("audio", blob, "q.webm");
          fd.append("section", String(cur!.i));
          const r = await api<{ text: string; url: string }>(`/api/books/${id}/ask`, { method: "POST", body: fd });
          setAnswer(r.text);
          setLoading("");
          const a = audioRef.current!;
          answerPlaying.current = { src: a.src, t: a.currentTime, it: curRef.current };
          a.src = r.url;
          a.playbackRate = rate;
          await a.play();
        } catch (e) {
          setLoading("");
          setErr((e as Error).message);
          if (resumeAfterAsk.current) audioRef.current?.play().catch(() => {});
        }
      };
      resumeAfterAsk.current = !audioRef.current?.paused;
      audioRef.current?.pause();
      recorder.current = mr;
      mr.start();
      setRec(true);
    } catch (e) {
      setErr("אין גישה למיקרופון: " + (e as Error).message);
    }
  }
  function stopRec() {
    recorder.current?.state === "recording" && recorder.current.stop();
  }

  // ---- תצוגה ----
  const chapterTitle = useMemo(() => (book && cur ? book.chapters[book.sections[cur.i]?.chapter]?.title ?? "" : ""), [book, cur]);
  const isHebrewBook = book?.lang === "he";
  const showLtr = !!cur && cur.kind === "section" && cur.lang === "orig" && !isHebrewBook;

  const audioEl = <audio ref={audioRef} preload="auto" playsInline onEnded={onEnded} onTimeUpdate={onTime} onPlay={onPlay} onPause={onPause} onError={onAudioError} />;

  if (err && !book) {
    return (
      <main className="page">
        <p className="err">{err}</p>
        <Link href="/">← לספרייה</Link>
        {audioEl}
      </main>
    );
  }
  if (!book || !cur || !prog) {
    return (
      <main className="page">
        <p className="muted">
          <span className="spinner" /> טוען…
        </p>
        {audioEl}
      </main>
    );
  }

  const noSections = book.sections.length === 0;

  return (
    <main className="page">
      <div className="row">
        <Link href="/" className="muted">
          ← הספרייה
        </Link>
        <span className="grow" />
        <span className="pill">
          קטע {cur.i + 1} / {book.sections.length}
        </span>
      </div>
      <div className="title" dir="auto">
        {book.title}
      </div>
      <div className="muted" dir="auto">
        {book.author}
        {chapterTitle ? ` · ${chapterTitle}` : ""}
      </div>
      {extractMsg && (
        <p className="muted">
          <span className="spinner" /> {extractMsg}
        </p>
      )}

      <div className="row wrap" style={{ margin: "12px 0" }}>
        {!isHebrewBook && (
          <>
            <button className={cur.lang === "he" ? "on" : "ghost"} onClick={() => setLang("he")}>
              עברית
            </button>
            <button className={cur.lang === "orig" ? "on" : "ghost"} onClick={() => setLang("orig")}>
              מקור
            </button>
          </>
        )}
        <button className={prog.study ? "on" : "ghost"} onClick={() => setStudy(!prog.study)}>
          {prog.study ? "מצב לימוד: פועל" : "מצב לימוד: כבוי"}
        </button>
        <button className="ghost" onClick={changeRate}>
          מהירות ×{rate}
        </button>
      </div>

      <div className="status">
        {loading && (
          <span className="muted">
            <span className="spinner" /> {loading}
          </span>
        )}
        {err && <span className="err">{err}</span>}
      </div>

      {cur.kind === "explain" && <div className="pill">הסבר של המורה</div>}
      <div className={"sectionText" + (showLtr ? " ltr" : "")} dir={showLtr ? "ltr" : "rtl"}>
        {curText || book.sections[cur.i]?.text}
      </div>
      {answer && (
        <div className="card">
          <div className="pill">תשובה</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{answer}</div>
        </div>
      )}

      <div className="controls">
        <div className="bar">
          <div style={{ width: pos.d ? `${(pos.t / pos.d) * 100}%` : "0%" }} />
        </div>
        <div className="row" style={{ justifyContent: "center", gap: 14 }}>
          <button className="iconBtn ghost" onClick={goNextSection} aria-label="הקטע הבא" disabled={cur.i + 1 >= book.sections.length}>
            ⏭
          </button>
          <button className="iconBtn ghost" onClick={() => audioRef.current && (audioRef.current.currentTime += 15)} aria-label="קדימה 15 שניות">
            +15
          </button>
          <button className="bigPlay" onClick={togglePlay} aria-label={playing ? "השהה" : "נגן"} disabled={noSections}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button className="iconBtn ghost" onClick={() => audioRef.current && (audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15))} aria-label="אחורה 15 שניות">
            -15
          </button>
          <button className="iconBtn ghost" onClick={goPrevSection} aria-label="הקטע הקודם">
            ⏮
          </button>
        </div>
        <div style={{ height: 10 }} />
        <button
          className={"askBtn" + (rec ? " rec" : "")}
          onPointerDown={(e) => {
            e.preventDefault();
            startRec();
          }}
          onPointerUp={stopRec}
          onPointerCancel={stopRec}
          onPointerLeave={() => rec && stopRec()}
          disabled={noSections}
        >
          {rec ? "● מקליט… שחרר כדי לשלוח" : "🎤 לחץ והחזק כדי לשאול את המורה"}
        </button>
      </div>

      <h2>פרקים</h2>
      {book.chapters.map((c, ci) => (
        <div key={ci} className="card clickable row" onClick={() => jumpTo(c.start)}>
          <div className="grow" dir="auto">
            {c.title}
          </div>
          <span className="muted">{c.end - c.start + 1} קטעים</span>
        </div>
      ))}

      {audioEl}
    </main>
  );
}
