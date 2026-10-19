"use client";
// מסך ההאזנה: עמוד ספר גולל, הפסקה שמוקראת מסומנת והדף זז איתה, לחיצה על פסקה מתחילה משם,
// נגן קבוע למטה, בחירת קול ומהירות, מצב לימוד שקט (תקציר בחזרה, שאלה בסוף פרק), ושיחה חיה.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, type AudioResult, type BookFull, type Manifest, type Note, type Progress, type StreamItem } from "@/lib/client";
import { startLive, type LiveHandle, type LiveState } from "@/lib/live";

interface Voice {
  id: string;
  label: string;
}
type Sheet = null | "chapters" | "voice" | "aa" | "more" | "sleep" | "notes";
type Theme = "light" | "sepia" | "dark";
const RATES = [1, 1.25, 1.5, 1.75, 2, 0.8];
const RECAP_AFTER_MS = 6 * 3600 * 1000;

function fmt(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export default function Player({ id }: { id: string }) {
  const [book, setBook] = useState<BookFull | null>(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [he, setHe] = useState<Record<number, string>>({});
  const [ready, setReady] = useState<Set<number>>(new Set());
  const [cur, setCur] = useState(0);
  const [lang, setLang] = useState<"he" | "orig">("he");
  const [voice, setVoice] = useState("Puck");
  const [voiceEn, setVoiceEn] = useState("am_michael"); // קול אנגלי (Kokoro) להאזנה במקור
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesEn, setVoicesEn] = useState<Voice[]>([]);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState("");
  const [err, setErr] = useState("");
  const [pos, setPos] = useState({ t: 0, d: 0 });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [fontSize, setFontSize] = useState(19);
  const [interlude, setInterlude] = useState<"recap" | "question" | null>(null);
  const [interludeText, setInterludeText] = useState("");
  const [sleepAt, setSleepAt] = useState<number | "chapter" | null>(null);
  const [live, setLiveState] = useState<LiveState | null>(null);
  const [transcript, setTranscript] = useState<{ role: "user" | "model"; text: string }[]>([]);
  const [deep, setDeep] = useState(false); // "לחשוב לעומק": השאלות עוברות למוח הגדול
  const [liveBusy, setLiveBusy] = useState<"deep" | "note" | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [toast, setToast] = useState("");
  const [prepErr, setPrepErr] = useState(""); // למה ההכנה ברקע נעצרה
  const [previewing, setPreviewing] = useState("");

  const audioRef = useRef<HTMLAudioElement>(null);
  const bookRef = useRef<BookFull | null>(null);
  const curRef = useRef(0);
  const langRef = useRef<"he" | "orig">("he");
  const voiceRef = useRef("Puck");
  const voiceEnRef = useRef("am_michael");
  /** הקול שבו מקשיבים עכשיו: עברי או אנגלי לפי השפה */
  const audioVoice = () => (langRef.current === "he" ? voiceRef.current : voiceEnRef.current);
  const progRef = useRef<Progress | null>(null);
  const readyRef = useRef<Set<number>>(new Set());
  const cache = useRef(new Map<string, Promise<AudioResult>>());
  const manifestRef = useRef<Manifest | null>(null); // הזרם שמתנגן עכשיו: אילו קטעים ואיפה כל אחד מתחיל
  const nextManifestRef = useRef<Manifest | null>(null); // הזרם הבא, מוכן מראש לקראת סוף הנוכחי
  const segRef = useRef<StreamItem | null>(null); // הפריט (קטע/שאלה) שמתנגן ברגע זה
  const wantNext = useRef<number | null>(null); // קטע שהיה אמור להתחיל ולא התחיל (מסך כבוי) — נשלים כשחוזרים
  const pendingSeek = useRef<number | null>(null);
  const interludeRef = useRef<{ kind: "recap" } | { kind: "question"; chapter: number } | null>(null);
  const pendingRecap = useRef(false);
  const recapToken = useRef(0); // לביטול תזכורת שעוד נטענת (לחיצה נוספת על ▶ או "דלג")
  const lastManualScroll = useRef(0);
  const pausedAt = useRef(0);
  const liveHandle = useRef<LiveHandle | null>(null);
  const liveResume = useRef(false);
  const transcriptRef = useRef<{ role: "user" | "model"; text: string }[]>([]);
  const saveTimer = useRef<number | null>(null);
  const prepTimer = useRef<number | null>(null);
  const prepBusy = useRef(false);
  const sleepTimer = useRef<number | null>(null);

  useEffect(() => void (bookRef.current = book), [book]);
  useEffect(() => void (curRef.current = cur), [cur]);
  useEffect(() => void (langRef.current = lang), [lang]);
  useEffect(() => void (voiceRef.current = voice), [voice]);
  useEffect(() => void (voiceEnRef.current = voiceEn), [voiceEn]);
  useEffect(() => void (progRef.current = prog), [prog]);
  useEffect(() => void (readyRef.current = ready), [ready]);
  useEffect(() => void (transcriptRef.current = transcript), [transcript]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ---- העדפות תצוגה (בטלפון הזה בלבד) ----
  useEffect(() => {
    try {
      const t = localStorage.getItem("theme") as Theme | null;
      const f = Number(localStorage.getItem("fontSize"));
      if (t) setTheme(t);
      if (f) setFontSize(f);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
      localStorage.setItem("fontSize", String(fontSize));
    } catch {
      /* ignore */
    }
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme, fontSize]);

  const saveProgress = useCallback((patch: Partial<Progress>) => {
    api(`/api/books/${id}/progress`, { method: "PUT", body: JSON.stringify(patch) }).catch(() => {});
  }, [id]);

  // ---- הכנה מראש: מבקשים מהשרת להכין קדימה, ומעדכנים מה מוכן ומה תורגם ----
  const refreshText = useCallback(async () => {
    const t = await api<{ he: Record<number, string>; ready: number[] }>(`/api/books/${id}/text?voice=${encodeURIComponent(audioVoice())}&lang=${langRef.current}`);
    setHe(t.he);
    setReady(new Set(t.ready));
  }, [id]);

  const runPrepare = useCallback(async () => {
    if (prepBusy.current) return;
    prepBusy.current = true;
    try {
      const r = await api<{ ready: number[]; busy: boolean; generated: number; error?: string }>(`/api/books/${id}/prepare`, {
        method: "POST",
        body: JSON.stringify({ from: curRef.current, voice: audioVoice(), lang: langRef.current, budgetMs: 120_000 }),
      });
      setReady(new Set(r.ready));
      setPrepErr(r.error || "");
      if (r.generated > 0) await refreshText();
    } catch {
      /* ההכנה תנסה שוב בסיבוב הבא */
    } finally {
      prepBusy.current = false;
    }
  }, [id, refreshText]);

  // ---- טעינה ----
  useEffect(() => {
    (async () => {
      try {
        const [b, p, v] = await Promise.all([api<BookFull>(`/api/books/${id}`), api<Progress>(`/api/books/${id}/progress`), api<{ voices: Voice[]; default: string; voicesEn: Voice[]; defaultEn: string }>("/api/voices")]);
        setBook(b);
        setProg(p);
        setVoices(v.voices);
        setVoicesEn(v.voicesEn ?? []);
        const ve = p.voiceEn || v.defaultEn || "am_michael";
        setVoiceEn(ve);
        voiceEnRef.current = ve;
        api<{ notes: Note[] }>(`/api/books/${id}/notes`).then((n) => setNotes(n.notes)).catch(() => {});
        const vv = p.voice || v.default;
        setVoice(vv);
        voiceRef.current = vv;
        setRate(p.rate || 1);
        const l = b.lang === "he" ? "he" : p.lang;
        setLang(l);
        langRef.current = l;
        const start = Math.min(p.section, Math.max(0, b.sections.length - 1));
        setCur(start);
        curRef.current = start;
        if (p.study && start > 0 && p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > RECAP_AFTER_MS) pendingRecap.current = true;
        await refreshText();
        runPrepare();
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
    prepTimer.current = window.setInterval(runPrepare, 75_000);
    const poll = window.setInterval(() => refreshText().catch(() => {}), 20_000);
    return () => {
      if (prepTimer.current) window.clearInterval(prepTimer.current);
      window.clearInterval(poll);
      liveHandle.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- קריאת PDF בצעדים ----
  useEffect(() => {
    if (!book || book.extraction?.status !== "pending") return;
    let stop = false;
    (async () => {
      while (!stop) {
        const ex = bookRef.current?.extraction;
        if (!ex || ex.status !== "pending") break;
        setLoading(`קורא את הקובץ… עמוד ${ex.nextPage} מתוך ${ex.totalPages}`);
        try {
          const r = await api<{ busy?: boolean }>(`/api/books/${id}/extract-step`, { method: "POST" });
          if (r.busy) await new Promise((res) => setTimeout(res, 15000)); // השרת קורא ברקע — מחכים ובודקים שוב
          const fresh = await api<BookFull>(`/api/books/${id}`);
          if (stop) break;
          setBook(fresh);
          if (fresh.extraction?.status !== "pending") {
            setLoading("");
            runPrepare();
          }
          if (fresh.extraction?.status === "error") setErr("תקלה בקריאת הקובץ: " + fresh.extraction.error);
        } catch (e) {
          setErr("תקלה בקריאת הקובץ: " + (e as Error).message);
          break;
        }
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, book?.extraction?.status]);

  // ---- שמע של קטע: יצירה בשרת אם עוד לא הוכן (הזרם הרציף מנגן רק מה שכבר מוכן) ----
  const fetchAudio = useCallback(
    (i: number, l: "he" | "orig", v: string): Promise<AudioResult> => {
      const k = `${i}:${l}:${v}`;
      const hit = cache.current.get(k);
      if (hit) return hit;
      const p = api<AudioResult>(`/api/books/${id}/sections/${i}/audio?lang=${l}&voice=${encodeURIComponent(v)}`);
      cache.current.set(k, p);
      p.then((r) => {
        setReady((s) => new Set(s).add(i));
        if (l === "he") setHe((m) => (m[i] ? m : { ...m, [i]: r.text }));
      }).catch(() => cache.current.delete(k));
      return p;
    },
    [id],
  );

  // ---- הזרם הרציף: קובץ שמע אחד ארוך מכל מה שמוכן, כדי שלא יהיה "סוף שיר" כל שתי דקות ----
  const loadManifest = useCallback(
    (from: number) =>
      api<Manifest>(`/api/books/${id}/stream/manifest?from=${from}&lang=${langRef.current}&voice=${encodeURIComponent(audioVoice())}&study=${progRef.current?.study === false ? 0 : 1}`),
    [id],
  );
  const streamUrl = useCallback(
    (m: Manifest) => `/api/books/${id}/stream?from=${m.from}&upto=${m.upto}&qs=${m.qs.join(",")}&lang=${langRef.current}&voice=${encodeURIComponent(m.voice)}`,
    [id],
  );
  const itemAt = (m: Manifest, t: number): StreamItem | null => {
    let found: StreamItem | null = null;
    for (const it of m.items) {
      if (t >= it.start - 0.05) found = it;
      else break;
    }
    return found;
  };
  const itemOf = (m: Manifest | null, i: number) => m?.items.find((it) => it.kind === "section" && it.i === i) ?? null;

  /** מתחילים זרם מהקטע הזה (מייצרים אותו קודם אם עוד לא הוכן). */
  const playFrom = useCallback(
    async (i: number, opts: { offset?: number; ratio?: number; autoplay?: boolean } = {}) => {
      const a = audioRef.current;
      const b = bookRef.current;
      if (!a || !b || !b.sections[i]) return;
      setErr("");
      interludeRef.current = null;
      setInterlude(null);
      curRef.current = i;
      setCur(i);
      const l = langRef.current;
      const v = audioVoice();
      try {
        let m = await loadManifest(i);
        if (!m.items.length) {
          setLoading(l === "he" ? "מכין את הקטע הזה…" : "מכין את הקטע במקור…");
          await fetchAudio(i, l, v);
          m = await loadManifest(i);
          if (!m.items.length) throw new Error("הקטע עדיין לא מוכן");
        }
        if (curRef.current !== i) return;
        manifestRef.current = m;
        nextManifestRef.current = null;
        const first = m.items[0];
        const t0 = opts.ratio != null ? opts.ratio * first.seconds : Math.min(opts.offset ?? 0, Math.max(0, first.seconds - 2));
        pendingSeek.current = t0;
        a.src = streamUrl(m);
        a.playbackRate = rate;
        if (t0 > 0) a.currentTime = t0;
        segRef.current = first;
        setPos({ t: t0, d: first.seconds });
        if (opts.autoplay !== false) await a.play();
        setLoading("");
        setProg((p) => (p ? { ...p, section: i } : p));
        const isFirst = opts.autoplay !== false && !progRef.current?.startedAt;
        if (isFirst) setProg((p) => (p ? { ...p, startedAt: new Date().toISOString() } : p));
        saveProgress({ section: i, offset: Math.floor(t0), lang: l, ...(isFirst ? { startedAt: new Date().toISOString() } : {}) });
        if (isFirst) window.setTimeout(runPrepare, 1500); // מרגע ▶ הראשון — ההכנה ברקע מתחילה
      } catch (e) {
        setLoading("");
        setErr((e as Error).message || "תקלה בהשמעה");
      }
    },
    [fetchAudio, loadManifest, streamUrl, rate, saveProgress, runPrepare],
  );

  /** קפיצה לקטע: בתוך הזרם הנוכחי אם הוא שם (בלי להחליף קובץ), אחרת זרם חדש. */
  const seekToSection = useCallback(
    (i: number, ratio = 0) => {
      const a = audioRef.current;
      const m = manifestRef.current;
      const it = itemOf(m, i);
      // הזרם "טרי" אם לא הוכן כלום מעבר לסופו; אחרת בונים זרם חדש (שיכלול גם שאלות סוף פרק שנוצרו בינתיים)
      const fresh = !!m && !readyRef.current.has(m.upto + 1);
      if (a && it && a.src && fresh) {
        a.currentTime = it.start + ratio * it.seconds;
        if (a.paused) a.play().catch(() => {});
        return;
      }
      playFrom(i, { ratio });
    },
    [playFrom],
  );

  // ---- תקציר בחזרה אחרי הפסקה (קובץ נפרד; בסופו מתחיל הזרם) ----
  const playRecap = useCallback(async () => {
    const a = audioRef.current;
    if (!a) return;
    const i = curRef.current;
    const token = ++recapToken.current;
    try {
      setLoading("מכין תזכורת קצרה… (▶ מדלג)");
      const r = await api<{ text: string; url: string }>(`/api/books/${id}/recap?upto=${i}`);
      if (token !== recapToken.current) return; // בוטל בינתיים
      setLoading("");
      interludeRef.current = { kind: "recap" };
      manifestRef.current = null;
      setInterlude("recap");
      setInterludeText(r.text);
      a.src = r.url;
      a.playbackRate = rate;
      await a.play();
    } catch {
      if (token !== recapToken.current) return;
      setLoading("");
      interludeRef.current = null;
      setInterlude(null);
      playFrom(i, { offset: progRef.current?.offset || 0 });
    }
  }, [id, rate, playFrom]);

  /** דילוג על התזכורת / השאלה — ישר לספר. */
  const skipInterlude = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    recapToken.current++;
    const il = interludeRef.current;
    interludeRef.current = null;
    setInterlude(null);
    setLoading("");
    if (!il || il.kind === "recap") {
      playFrom(curRef.current, { offset: progRef.current?.offset || 0 });
      return;
    }
    // שאלה בתוך הזרם: קופצים לפריט הבא
    const m = manifestRef.current;
    const seg = segRef.current;
    if (m && seg) {
      const k = m.items.indexOf(seg);
      const next = m.items[k + 1];
      if (next) a.currentTime = next.start;
      else playFrom(Math.min(m.upto + 1, (bookRef.current?.sections.length ?? 1) - 1));
    }
  }, [playFrom]);

  // ---- אירועי הנגן ----
  const onEnded = () => {
    const a = audioRef.current;
    const b = bookRef.current;
    if (!a || !b) return;
    if (interludeRef.current?.kind === "recap") {
      interludeRef.current = null;
      setInterlude(null);
      playFrom(curRef.current, { offset: progRef.current?.offset || 0 });
      return;
    }
    const m = manifestRef.current;
    const next = m ? m.upto + 1 : curRef.current + 1;
    if (next >= b.sections.length) {
      setPlaying(false);
      return;
    }
    const nm = nextManifestRef.current;
    if (nm && nm.from === next && nm.items.length) {
      // הזרם הבא כבר הוכן מראש — מחליפים באותו רגע, בלי רשת
      manifestRef.current = nm;
      nextManifestRef.current = null;
      curRef.current = next;
      segRef.current = nm.items[0];
      a.src = streamUrl(nm);
      a.playbackRate = rate;
      a.play().catch(() => {
        wantNext.current = next;
      });
      setCur(next);
      setInterlude(null);
      saveProgress({ section: next, offset: 0, lang: langRef.current });
      return;
    }
    wantNext.current = next;
    playFrom(next).then(() => {
      if (curRef.current === next && !audioRef.current?.paused) wantNext.current = null;
    });
  };
  const onLoaded = () => {
    const a = audioRef.current;
    if (a && pendingSeek.current != null && pendingSeek.current > 0 && Math.abs(a.currentTime - pendingSeek.current) > 1) a.currentTime = pendingSeek.current;
    pendingSeek.current = null;
  };
  const onTime = () => {
    const a = audioRef.current;
    const b = bookRef.current;
    if (!a || !b) return;
    const m = manifestRef.current;
    if (!m) {
      setPos({ t: a.currentTime, d: isFinite(a.duration) ? a.duration : 0 });
      return;
    }
    const it = itemAt(m, a.currentTime);
    if (!it) return;
    const prev = segRef.current;
    segRef.current = it;
    if (it.kind === "section") {
      if (prev && prev !== it && sleepAt === "chapter" && prev.chapter !== it.chapter) {
        a.pause();
        setSleepAt(null);
      }
      if (curRef.current !== it.i) {
        curRef.current = it.i;
        setCur(it.i);
        setProg((p) => (p ? { ...p, section: it.i } : p));
      }
      if (interludeRef.current) {
        interludeRef.current = null;
        setInterlude(null);
      }
    } else if (interludeRef.current?.kind !== "question" || interludeRef.current.chapter !== it.i) {
      interludeRef.current = { kind: "question", chapter: it.i };
      setInterlude("question");
      setInterludeText("");
      api<{ text: string }>(`/api/books/${id}/chapters/${it.i}/question`).then((r) => setInterludeText(r.text)).catch(() => {});
    }
    const rel = Math.max(0, a.currentTime - it.start);
    setPos({ t: rel, d: it.seconds });
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setPositionState({ duration: it.seconds, playbackRate: a.playbackRate, position: Math.min(rel, it.seconds) });
      } catch {
        /* ignore */
      }
    }
    if (saveTimer.current == null) {
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const a2 = audioRef.current;
        const seg = segRef.current;
        if (a2 && !a2.paused && seg && seg.kind === "section") saveProgress({ section: seg.i, offset: Math.floor(Math.max(0, a2.currentTime - seg.start)) });
      }, 15000);
    }
    // לקראת סוף הזרם: אם בינתיים הוכנו עוד קטעים — מכינים את הזרם הבא מראש, כדי שההחלפה תהיה מיידית
    if (m.totalSeconds - a.currentTime < 120 && !nextManifestRef.current && m.upto + 1 < b.sections.length && readyRef.current.has(m.upto + 1)) {
      nextManifestRef.current = { ...m, items: [] }; // מסמן "בטעינה"
      loadManifest(m.upto + 1)
        .then((n) => {
          nextManifestRef.current = n.items.length ? n : null;
        })
        .catch(() => (nextManifestRef.current = null));
    }
  };
  const onPlay = () => {
    setPlaying(true);
    wantNext.current = null;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  };
  const onPause = () => {
    setPlaying(false);
    pausedAt.current = Date.now();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    const a = audioRef.current;
    const seg = segRef.current;
    if (a && !a.ended && seg && seg.kind === "section" && manifestRef.current) saveProgress({ section: seg.i, offset: Math.floor(Math.max(0, a.currentTime - seg.start)) });
  };

  // ---- Media Session ----
  const goNext = useCallback(() => {
    const b = bookRef.current;
    if (b && curRef.current + 1 < b.sections.length) seekToSection(curRef.current + 1);
  }, [seekToSection]);
  const goPrev = useCallback(() => {
    const a = audioRef.current;
    const seg = segRef.current;
    if (a && seg && manifestRef.current && a.currentTime - seg.start > 4) {
      a.currentTime = seg.start;
      return;
    }
    seekToSection(Math.max(0, curRef.current - 1));
  }, [seekToSection]);
  useEffect(() => {
    if (!("mediaSession" in navigator) || !book) return;
    const ms = navigator.mediaSession;
    const chapter = book.chapters[book.sections[cur]?.chapter]?.title ?? "";
    ms.metadata = new MediaMetadata({
      title: chapter || book.title,
      artist: book.title + (book.author ? " · " + book.author : ""),
      album: `קטע ${cur + 1} מתוך ${book.sections.length}`,
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
    set("play", () => togglePlay());
    set("pause", () => a.pause());
    set("nexttrack", goNext);
    set("previoustrack", goPrev);
    set("seekbackward", (d) => (a.currentTime = Math.max(0, a.currentTime - (d.seekOffset || 15))));
    set("seekforward", (d) => (a.currentTime = Math.min(a.duration || 0, a.currentTime + (d.seekOffset || 15))));
    set("seekto", (d) => {
      if (d.seekTime != null) a.currentTime = (manifestRef.current ? segRef.current?.start ?? 0 : 0) + d.seekTime;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, cur, goNext, goPrev]);

  // ---- חזרה למסך: אם הזרם נגמר והבא לא התחיל בזמן שהמסך היה כבוי — ממשיכים ----
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const a = audioRef.current;
      if (a && a.paused && wantNext.current != null) {
        const next = wantNext.current;
        wantNext.current = null;
        playFrom(next);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [playFrom]);

  // ---- גלילה אוטומטית לפסקה הנוכחית ----
  const paraIdx = useMemo(() => {
    const text = (lang === "he" ? he[cur] : undefined) ?? book?.sections[cur]?.text ?? "";
    const paras = text.split(/\n\n+/);
    if (paras.length <= 1 || !pos.d) return 0;
    const total = text.length;
    const at = (pos.t / pos.d) * total;
    let acc = 0;
    for (let k = 0; k < paras.length; k++) {
      acc += paras[k].length + 2;
      if (at < acc) return k;
    }
    return paras.length - 1;
  }, [he, cur, lang, pos, book]);

  useEffect(() => {
    if (Date.now() - lastManualScroll.current < 4000) return;
    const el = document.getElementById(`p-${cur}-${paraIdx}`) || document.getElementById(`s-${cur}`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const target = window.scrollY + rect.top - window.innerHeight * 0.28;
    if (Math.abs(target - window.scrollY) > 40) window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [cur, paraIdx]);
  useEffect(() => {
    let ticking = false;
    const onWheel = () => {
      lastManualScroll.current = Date.now();
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(() => (ticking = false));
      }
    };
    window.addEventListener("touchmove", onWheel, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("touchmove", onWheel);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // ---- שעון שינה ----
  useEffect(() => {
    if (sleepTimer.current) window.clearTimeout(sleepTimer.current);
    if (typeof sleepAt === "number") {
      sleepTimer.current = window.setTimeout(() => {
        audioRef.current?.pause();
        setSleepAt(null);
      }, Math.max(0, sleepAt - Date.now()));
    }
    return () => {
      if (sleepTimer.current) window.clearTimeout(sleepTimer.current);
    };
  }, [sleepAt]);

  // ---- פעולות ----
  async function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (!a.src) {
      if (loading.startsWith("מכין תזכורת")) {
        // לחיצה נוספת בזמן שהתזכורת נטענת — מוותרים עליה ומתחילים את הספר
        skipInterlude();
        return;
      }
      if (pendingRecap.current) {
        pendingRecap.current = false;
        await playRecap(); // אחרי התזכורת מתחיל הזרם מהמקום שנעצר
        return;
      }
      await playFrom(curRef.current, { offset: progRef.current?.offset || 0 });
      return;
    }
    if (a.paused) {
      if (wantNext.current != null || a.ended) {
        // הזרם נגמר והבא לא התחיל (מסך כבוי) — ממשיכים ממנו
        const next = wantNext.current ?? (manifestRef.current ? manifestRef.current.upto + 1 : curRef.current + 1);
        wantNext.current = null;
        await playFrom(Math.min(next, (bookRef.current?.sections.length ?? 1) - 1));
        return;
      }
      if (pausedAt.current && Date.now() - pausedAt.current > 60_000 && !interludeRef.current) a.currentTime = Math.max(0, a.currentTime - 5);
      await a.play();
    } else a.pause();
  }
  function seekInSection(ratio: number) {
    const a = audioRef.current;
    const seg = segRef.current;
    if (!a) return;
    if (manifestRef.current && seg) a.currentTime = seg.start + ratio * seg.seconds;
    else if (pos.d) a.currentTime = ratio * pos.d;
  }
  function jumpToParagraph(i: number, k: number, paras: string[]) {
    const before = paras.slice(0, k).reduce((n, p) => n + p.length + 2, 0);
    const total = paras.reduce((n, p) => n + p.length + 2, 0) || 1;
    seekToSection(i, before / total);
  }
  function restartStream(autoplay: boolean) {
    const a = audioRef.current;
    const seg = segRef.current;
    const offset = a && seg && manifestRef.current && seg.kind === "section" ? Math.max(0, a.currentTime - seg.start) : progRef.current?.offset || 0;
    if (a?.src) playFrom(curRef.current, { autoplay, offset });
  }
  function changeLang(l: "he" | "orig") {
    if (l === lang) return;
    setLang(l);
    langRef.current = l;
    saveProgress({ lang: l });
    // "מוכן" הוא לפי שפה — מתחילים לספור מחדש, וההכנה ברקע עוברת לשפה הזו
    setReady(new Set());
    readyRef.current = new Set();
    setPrepErr("");
    const was = !audioRef.current?.paused;
    if (audioRef.current?.src) playFrom(curRef.current, { autoplay: was });
    refreshText().then(() => runPrepare()).catch(() => {});
  }
  function changeVoice(v: string) {
    if (lang === "he") {
      setVoice(v);
      voiceRef.current = v;
      saveProgress({ voice: v });
    } else {
      setVoiceEn(v);
      voiceEnRef.current = v;
      saveProgress({ voiceEn: v });
    }
    setSheet(null);
    cache.current.clear();
    setReady(new Set());
    refreshText().then(runPrepare);
    restartStream(!audioRef.current?.paused);
  }
  async function preview(v: string) {
    setPreviewing(v);
    try {
      const r = await api<{ url: string }>(`/api/books/${id}/preview?voice=${encodeURIComponent(v)}`);
      const a = new Audio(r.url);
      a.onended = () => setPreviewing("");
      await a.play();
    } catch (e) {
      setPreviewing("");
      setErr((e as Error).message);
    }
  }
  function cycleRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
    saveProgress({ rate: next });
  }
  function setStudy(on: boolean) {
    setProg((p) => (p ? { ...p, study: on } : p));
    saveProgress({ study: on });
  }

  // ---- שיחה חיה ----
  async function startConversation() {
    const a = audioRef.current;
    if (!a || live) return;
    liveResume.current = !a.paused;
    a.pause();
    setTranscript([]);
    transcriptRef.current = [];
    setDeep(false);
    setLiveBusy(null);
    setLiveState("connecting");
    try {
      const t = await api<{ token: string; model: string }>(`/api/books/${id}/live`, { method: "POST", body: JSON.stringify({ section: curRef.current }) });
      liveHandle.current = await startLive(t.token, t.model, {
        onState: (s) => setLiveState(s),
        onTranscript: (role, text) =>
          setTranscript((tr) => {
            const last = tr[tr.length - 1];
            if (last && last.role === role) return [...tr.slice(0, -1), { role, text }];
            return [...tr, { role, text }];
          }),
        onError: (m) => setErr(m),
        onToolCall: async (name, args) => {
          if (name === "deep_think") {
            setLiveBusy("deep");
            try {
              const r = await api<{ answer: string }>(`/api/books/${id}/deep`, {
                method: "POST",
                body: JSON.stringify({ section: curRef.current, question: String(args.question ?? ""), transcript: transcriptRef.current.slice(-20) }),
              });
              return { answer: r.answer };
            } finally {
              setLiveBusy(null);
            }
          }
          if (name === "save_note") {
            setLiveBusy("note");
            try {
              const r = await api<{ note: Note }>(`/api/books/${id}/notes`, {
                method: "POST",
                body: JSON.stringify({ section: curRef.current, title: String(args.title ?? ""), text: String(args.text ?? "") }),
              });
              setNotes((n) => [r.note, ...n]);
              setToast("הפתק נשמר");
              return { ok: true, saved: true };
            } finally {
              setLiveBusy(null);
            }
          }
          return { ok: false, error: "unknown tool" };
        },
      });
    } catch (e) {
      setLiveState(null);
      setErr("השיחה לא התחילה: " + (e as Error).message);
    }
  }
  function toggleDeep() {
    const next = !deep;
    setDeep(next);
    liveHandle.current?.sendText(
      next
        ? "[הודעת מערכת] מצב 'לחשוב לעומק' הופעל. מעכשיו, על כל שאלה או טענה של המאזין קרא ל-deep_think והקרא את התשובה כפי שהיא. אל תענה בעצמך. אל תגיב להודעה הזו."
        : "[הודעת מערכת] מצב 'לחשוב לעומק' כובה. מעכשיו ענה בעצמך כרגיל. אל תגיב להודעה הזו.",
      false,
    );
  }
  function requestNote() {
    liveHandle.current?.sendText("[המאזין לחץ על כפתור הפתק] קרא עכשיו ל-save_note עם תמצית מה שדיברנו עליו לאחרונה, ואז אמור משפט אחד שהפתק נשמר.", true);
  }
  async function removeNote(noteId: string) {
    setNotes((n) => n.filter((x) => x.id !== noteId));
    await api(`/api/books/${id}/notes?note=${noteId}`, { method: "DELETE" }).catch(() => {});
  }
  function notesAsText() {
    return notes
      .slice()
      .reverse()
      .map((n) => `${n.title}\n(${n.chapter || "—"} · ${new Date(n.at).toLocaleDateString("he-IL")})\n${n.text}`)
      .join("\n\n---\n\n");
  }
  async function shareNotes() {
    const text = `פתקים — ${book?.title ?? ""}\n\n${notesAsText()}`;
    try {
      if (navigator.share) await navigator.share({ title: `פתקים — ${book?.title ?? ""}`, text });
      else {
        await navigator.clipboard.writeText(text);
        setToast("הפתקים הועתקו");
      }
    } catch {
      /* ביטול */
    }
  }
  function endConversation() {
    liveHandle.current?.stop();
    liveHandle.current = null;
    setLiveState(null);
    setDeep(false);
    // סיכום אוטומטי של השיחה — פתק, ברקע
    const tr = transcriptRef.current;
    if (tr.filter((t) => t.role === "user" && t.text.trim().length > 15).length >= 2) {
      setToast("כותב פתק סיכום לשיחה…");
      api<{ note: Note | null }>(`/api/books/${id}/notes`, { method: "POST", body: JSON.stringify({ section: curRef.current, transcript: tr.slice(-60) }) })
        .then((r) => {
          if (r.note) {
            setNotes((n) => [r.note!, ...n]);
            setToast("נשמר פתק סיכום של השיחה");
          }
        })
        .catch(() => setToast("לא הצלחתי לכתוב פתק סיכום"));
    }
    const a = audioRef.current;
    if (a && a.src) {
      a.currentTime = Math.max(0, a.currentTime - 5);
      if (liveResume.current) a.play().catch(() => {});
    }
  }

  // ---- תצוגה ----
  const audioEl = <audio ref={audioRef} preload="auto" playsInline onEnded={onEnded} onTimeUpdate={onTime} onPlay={onPlay} onPause={onPause} onLoadedMetadata={onLoaded} onError={() => setErr("הדפדפן לא הצליח לנגן את הקובץ")} />;

  if (err && !book) {
    return (
      <main className="page">
        <p className="err">{err}</p>
        <Link href="/">← לספרייה</Link>
        {audioEl}
      </main>
    );
  }
  if (!book || !prog) {
    return (
      <main className="page">
        <p className="muted">
          <span className="spinner" /> טוען…
        </p>
        {audioEl}
      </main>
    );
  }

  const chapter = book.chapters[book.sections[cur]?.chapter];
  const readyCount = ready.size;
  const isHebrewBook = book.lang === "he";
  const showOrig = lang === "orig" && !isHebrewBook;
  const noSections = book.sections.length === 0;
  const voiceList = lang === "he" ? voices : voicesEn;
  const curVoice = lang === "he" ? voice : voiceEn;
  const voiceLabel = voiceList.find((v) => v.id === curVoice)?.label.split(" — ")[0] ?? curVoice;

  return (
    <div className="reader" style={{ fontSize }}>
      <header className="readerTop">
        <Link href="/" className="muted" aria-label="לספרייה">
          →
        </Link>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="readerTitle" dir="auto">
            {book.title}
          </div>
          <div className="muted small" dir="auto">
            {chapter?.title ? chapter.title : book.author}
            {" · "}
            {cur + 1}/{book.sections.length}
            {book.lang !== "other" && readyCount < book.sections.length ? ` · מוכן ${Math.round((readyCount / book.sections.length) * 100)}%` : ""}
          </div>
        </div>
        <button className="chip" onClick={() => setSheet("aa")} aria-label="תצוגה">
          Aa
        </button>
      </header>

      <main className="bookText" dir={showOrig ? "ltr" : "rtl"}>
        {loading && (
          <p className="muted small">
            <span className="spinner" /> {loading}
          </p>
        )}
        {err && <p className="err small">{err}</p>}
        {prepErr && !err && <p className="err small">ההכנה ברקע נעצרה: {prepErr}</p>}
        {interlude && (
          <div className="interlude">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div className="pill">{interlude === "recap" ? "תזכורת: מה שמעת עד עכשיו" : "שאלה לסיום הפרק — רגע לחשוב, ואז ממשיכים"}</div>
              <button className="ghost sm" onClick={skipInterlude}>דלג ⏭</button>
            </div>
            <div>{interludeText}</div>
          </div>
        )}
        {noSections && <p className="muted">הטקסט עוד נקרא מהקובץ…</p>}
        {book.chapters.map((c, ci) => (
          <section key={ci}>
            <h2 className="chapterHead" dir="auto">
              {c.title}
            </h2>
            {book.sections.slice(c.start, c.end + 1).map((s) => {
              const text = (showOrig ? s.text : he[s.i]) ?? (showOrig ? s.text : undefined);
              const translated = showOrig || isHebrewBook || !!he[s.i];
              const paras = (text ?? s.text).split(/\n\n+/);
              const isCur = s.i === cur;
              const isReady = showOrig || ready.has(s.i);
              return (
                <div key={s.i} id={`s-${s.i}`} className={"sec" + (isCur ? " cur" : "") + (isReady ? "" : " notReady") + (translated ? "" : " untranslated")} dir={translated && !showOrig ? "rtl" : showOrig ? "ltr" : "ltr"}>
                  {paras.map((p, k) => (
                    <p key={k} id={`p-${s.i}-${k}`} className={isCur && k === paraIdx && playing ? "para now" : "para"} onClick={() => jumpToParagraph(s.i, k, paras)}>
                      {p}
                    </p>
                  ))}
                </div>
              );
            })}
          </section>
        ))}
        <div style={{ height: 180 }} />
      </main>

      <footer className="playerBar">
        <div className="bar" onClick={(e) => {
          if (!pos.d) return;
          const r = e.currentTarget.getBoundingClientRect();
          seekInSection(1 - (e.clientX - r.left) / r.width); // RTL
        }}>
          <div style={{ width: pos.d ? `${(pos.t / pos.d) * 100}%` : "0%" }} />
        </div>
        <div className="row small muted" style={{ justifyContent: "space-between" }}>
          <span>{fmt(pos.t / rate)}</span>
          <span>{pos.d ? "-" + fmt((pos.d - pos.t) / rate) : ""}</span>
        </div>
        <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
          <button className="iconBtn mic" onClick={startConversation} disabled={noSections || !!live} aria-label="דבר עם הספר">
            🎤
          </button>
          <button className="iconBtn ghost" onClick={goPrev} aria-label="הקטע הקודם">
            ⏮
          </button>
          <button className="iconBtn ghost sm" onClick={() => audioRef.current && (audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15))} aria-label="אחורה 15 שניות">
            15-
          </button>
          <button className="bigPlay" onClick={togglePlay} disabled={noSections} aria-label={playing ? "השהה" : "נגן"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button className="iconBtn ghost sm" onClick={() => audioRef.current && (audioRef.current.currentTime += 15)} aria-label="קדימה 15 שניות">
            15+
          </button>
          <button className="iconBtn ghost" onClick={goNext} disabled={cur + 1 >= book.sections.length} aria-label="הקטע הבא">
            ⏭
          </button>
        </div>
        <div className="row chips">
          <button className="chip" onClick={cycleRate}>
            ×{rate}
          </button>
          <button className="chip" onClick={() => setSheet("voice")}>
            🗣 {voiceLabel}
          </button>
          {!isHebrewBook && (
            <button className="chip" onClick={() => changeLang(lang === "he" ? "orig" : "he")}>
              {lang === "he" ? "מקור" : "עברית"}
            </button>
          )}
          <button className="chip" onClick={() => setSheet("chapters")}>
            פרקים
          </button>
          <button className="chip" onClick={() => setSheet("notes")}>
            📝 פתקים{notes.length ? ` (${notes.length})` : ""}
          </button>
          <button className="chip" onClick={() => setSheet("more")}>
            ⋯
          </button>
        </div>
      </footer>

      {sheet && <div className="scrim" onClick={() => setSheet(null)} />}
      {sheet === "chapters" && (
        <div className="sheet">
          <div className="sheetTitle">פרקים</div>
          {book.chapters.map((c, ci) => {
            const n = c.end - c.start + 1;
            const r = book.sections.slice(c.start, c.end + 1).filter((s) => ready.has(s.i)).length;
            return (
              <div key={ci} className={"card clickable row" + (book.sections[cur]?.chapter === ci ? " on" : "")} onClick={() => { setSheet(null); seekToSection(c.start); }}>
                <div className="grow" dir="auto">{c.title}</div>
                <span className="muted small">{r === n ? "✓" : `${r}/${n}`}</span>
              </div>
            );
          })}
        </div>
      )}
      {sheet === "voice" && (
        <div className="sheet">
          <div className="sheetTitle">{lang === "he" ? "קול ההקראה בעברית" : "קול ההקראה באנגלית"}</div>
          <p className="muted small">
            {lang === "he"
              ? "לחיצה על ▶ משמיעה פסקה מהספר הזה בקול. בחירה מחליפה את הקול לספר הזה (קטעים שכבר הוכנו ייווצרו מחדש ברקע)."
              : "קולות של Kokoro — מודל קוד פתוח שרץ על השרת שלנו, בלי עלות לפי תו. ההכנה איטית יותר (כ-3 דקות לקטע) ורצה ברקע."}
          </p>
          {voiceList.map((v) => (
            <div key={v.id} className={"card row" + (v.id === curVoice ? " on" : "")}>
              <button className="iconBtn ghost sm" onClick={() => preview(v.id)} disabled={!!previewing} aria-label="דוגמה">
                {previewing === v.id ? <span className="spinner" /> : "▶"}
              </button>
              <div className="grow">{v.label}</div>
              <button className={v.id === curVoice ? "primary" : "ghost"} onClick={() => changeVoice(v.id)}>
                {v.id === curVoice ? "נבחר" : "בחר"}
              </button>
            </div>
          ))}
        </div>
      )}
      {sheet === "aa" && (
        <div className="sheet">
          <div className="sheetTitle">תצוגה</div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="ghost" onClick={() => setFontSize((f) => Math.max(15, f - 1))}>א-</button>
            <span>{fontSize}</span>
            <button className="ghost" onClick={() => setFontSize((f) => Math.min(26, f + 1))}>א+</button>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {(["light", "sepia", "dark"] as Theme[]).map((t) => (
              <button key={t} className={"grow " + (theme === t ? "on" : "ghost")} onClick={() => setTheme(t)}>
                {t === "light" ? "בהיר" : t === "sepia" ? "ספיה" : "כהה"}
              </button>
            ))}
          </div>
        </div>
      )}
      {sheet === "more" && (
        <div className="sheet">
          <div className="sheetTitle">עוד</div>
          <div className="card row">
            <div className="grow">
              <div>מצב לימוד שקט</div>
              <div className="muted small">תזכורת קצרה כשחוזרים אחרי הפסקה, ושאלה אחת בסוף כל פרק</div>
            </div>
            <button className={prog.study ? "on" : "ghost"} onClick={() => setStudy(!prog.study)}>
              {prog.study ? "פועל" : "כבוי"}
            </button>
          </div>
          <div className="card row">
            <div className="grow">
              <div>שעון שינה</div>
              <div className="muted small">{sleepAt === "chapter" ? "עד סוף הפרק" : typeof sleepAt === "number" ? `עוד ${fmt((sleepAt - Date.now()) / 1000)}` : "כבוי"}</div>
            </div>
            <button className="ghost" onClick={() => setSheet("sleep")}>בחר</button>
          </div>
        </div>
      )}
      {sheet === "notes" && (
        <div className="sheet">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="sheetTitle">פתקים</div>
            {notes.length > 0 && <button className="ghost" onClick={shareNotes}>שתף / העתק</button>}
          </div>
          {notes.length === 0 && <p className="muted small">עוד אין פתקים. בשיחה אמור "תשמור את זה" או לחץ על 📝, ובסוף כל שיחה נכתב פתק סיכום אוטומטית.</p>}
          {notes.map((n) => (
            <div key={n.id} className="card">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div className="grow">
                  <div style={{ fontWeight: 700 }}>{n.title}</div>
                  <div className="muted small">
                    {n.kind === "summary" ? "סיכום שיחה" : "פתק"} · {n.chapter || ""} · {new Date(n.at).toLocaleDateString("he-IL")}
                  </div>
                </div>
                <button className="ghost sm" onClick={() => removeNote(n.id)} aria-label="מחק פתק">✕</button>
              </div>
              <p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{n.text}</p>
            </div>
          ))}
        </div>
      )}
      {sheet === "sleep" && (
        <div className="sheet">
          <div className="sheetTitle">שעון שינה</div>
          <div className="row wrap">
            {[15, 30, 45, 60].map((m) => (
              <button key={m} className="ghost" onClick={() => { setSleepAt(Date.now() + m * 60000); setSheet(null); }}>{m} דק׳</button>
            ))}
            <button className="ghost" onClick={() => { setSleepAt("chapter"); setSheet(null); }}>סוף הפרק</button>
            <button className="ghost" onClick={() => { setSleepAt(null); setSheet(null); }}>כבוי</button>
          </div>
        </div>
      )}

      {live && (
        <div className="liveOverlay">
          <div className="liveState">
            {liveBusy === "deep" && "חושב לעומק…"}
            {liveBusy === "note" && "שומר פתק…"}
            {!liveBusy && live === "connecting" && "מתחבר…"}
            {!liveBusy && live === "listening" && "מאזין — דבר"}
            {!liveBusy && live === "thinking" && "חושב…"}
            {!liveBusy && live === "speaking" && "מדבר…"}
            {!liveBusy && live === "error" && "תקלה בחיבור"}
            {!liveBusy && live === "closed" && "השיחה הסתיימה"}
          </div>
          <div className="transcript">
            {transcript.map((t, k) => (
              <div key={k} className={"line " + t.role}>{t.text}</div>
            ))}
          </div>
          <div className="row" style={{ gap: 10, marginTop: 12 }}>
            <button className={"grow liveTool" + (deep ? " on" : "")} onClick={toggleDeep} disabled={live === "connecting"}>
              🧠 {deep ? "חושב לעומק — פועל" : "לחשוב לעומק"}
            </button>
            <button className="grow liveTool" onClick={requestNote} disabled={live === "connecting" || !!liveBusy}>
              📝 שמור פתק
            </button>
          </div>
          <div className="muted small" style={{ textAlign: "center", marginTop: 6 }}>
            {deep ? "כל שאלה עוברת למודל הגדול: תשובה עמוקה יותר, כמה שניות המתנה, כ-20 אגורות לשאלה" : "תשובות מהירות מהמודל החי. לחץ 🧠 כשרוצים שהמודל הגדול יחשוב על השאלה"}
          </div>
          <button className="endLive" onClick={endConversation}>סיים וחזור לספר</button>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {audioEl}
    </div>
  );
}
