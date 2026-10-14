"use client";
// מסך ההאזנה: עמוד ספר גולל, הפסקה שמוקראת מסומנת והדף זז איתה, לחיצה על פסקה מתחילה משם,
// נגן קבוע למטה, בחירת קול ומהירות, מצב לימוד שקט (תקציר בחזרה, שאלה בסוף פרק), ושיחה חיה.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, type AudioResult, type BookFull, type Note, type Progress } from "@/lib/client";
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
  const [voices, setVoices] = useState<Voice[]>([]);
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
  const [previewing, setPreviewing] = useState("");

  const audioRef = useRef<HTMLAudioElement>(null);
  const bookRef = useRef<BookFull | null>(null);
  const curRef = useRef(0);
  const langRef = useRef<"he" | "orig">("he");
  const voiceRef = useRef("Puck");
  const progRef = useRef<Progress | null>(null);
  const readyRef = useRef<Set<number>>(new Set());
  const cache = useRef(new Map<string, Promise<AudioResult>>());
  const urls = useRef(new Map<string, string>()); // כתובות שכבר ידועות — כדי לעבור לקטע הבא בלי להמתין לרשת
  const questionUrls = useRef(new Map<string, string>()); // שאלת סוף פרק, לפי פרק+קול
  const wantNext = useRef<number | null>(null); // קטע שהיה אמור להתחיל ולא התחיל (מסך כבוי) — נשלים כשחוזרים
  const pendingSeekRatio = useRef<number | null>(null);
  const interludeRef = useRef<{ kind: "recap" | "question"; resume: { src: string; t: number; i: number } | null; then: "continue" | "next" } | null>(null);
  const pendingRecap = useRef(false);
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
    const t = await api<{ he: Record<number, string>; ready: number[] }>(`/api/books/${id}/text?voice=${encodeURIComponent(voiceRef.current)}`);
    setHe(t.he);
    setReady(new Set(t.ready));
  }, [id]);

  const runPrepare = useCallback(async () => {
    if (prepBusy.current) return;
    prepBusy.current = true;
    try {
      const r = await api<{ ready: number[]; busy: boolean; generated: number }>(`/api/books/${id}/prepare`, {
        method: "POST",
        body: JSON.stringify({ from: curRef.current, voice: voiceRef.current, budgetMs: 120_000 }),
      });
      setReady(new Set(r.ready));
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
        const [b, p, v] = await Promise.all([api<BookFull>(`/api/books/${id}`), api<Progress>(`/api/books/${id}/progress`), api<{ voices: Voice[]; default: string }>("/api/voices")]);
        setBook(b);
        setProg(p);
        setVoices(v.voices);
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
          await api(`/api/books/${id}/extract-step`, { method: "POST" });
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

  // ---- שמע של קטע (מהזיכרון, או יצירה אם עוד לא הוכן) ----
  const fetchAudio = useCallback(
    (i: number, l: "he" | "orig", v: string): Promise<AudioResult> => {
      const k = `${i}:${l}:${v}`;
      const hit = cache.current.get(k);
      if (hit) return hit;
      const p = api<AudioResult>(`/api/books/${id}/sections/${i}/audio?lang=${l}&voice=${encodeURIComponent(v)}`);
      cache.current.set(k, p);
      p.then((r) => {
        urls.current.set(k, r.url);
        if (l === "he") {
          setReady((s) => new Set(s).add(i));
          setHe((m) => (m[i] ? m : { ...m, [i]: r.text }));
        }
      }).catch(() => cache.current.delete(k));
      return p;
    },
    [id],
  );

  /** הכתובות של מה שמגיע אחרי הקטע הזה — כדי שהמעבר בסוף יהיה מיידי, גם כשהמסך כבוי. */
  const prefetchAhead = useCallback(
    (i: number) => {
      const b = bookRef.current;
      if (!b) return;
      const l = langRef.current;
      const v = voiceRef.current;
      if (b.sections[i + 1]) fetchAudio(i + 1, l, v).catch(() => {});
      if (b.sections[i + 2] && l === "he" && readyRef.current.has(i + 2)) fetchAudio(i + 2, l, v).catch(() => {});
      const c = b.sections[i]?.chapter;
      if (l === "he" && progRef.current?.study && b.chapters[c]?.end === i && b.sections[i + 1]) {
        const qk = `${c}:${v}`;
        if (!questionUrls.current.has(qk))
          api<{ text: string; url: string }>(`/api/books/${id}/chapters/${c}/question`)
            .then((r) => questionUrls.current.set(qk, r.url))
            .catch(() => {});
      }
    },
    [fetchAudio, id],
  );

  /** מעבר מיידי לקטע שכתובתו כבר ידועה: בלי המתנה, בלי רשת — קודם מנגנים, אחר כך מעדכנים מסך. */
  const startKnown = useCallback(
    (i: number, url: string) => {
      const a = audioRef.current;
      if (!a) return;
      interludeRef.current = null;
      curRef.current = i;
      a.src = url;
      a.playbackRate = rate;
      a.play().catch(() => {
        wantNext.current = i;
      });
      setInterlude(null);
      setCur(i);
      setProg((p) => (p ? { ...p, section: i } : p));
      saveProgress({ section: i, offset: 0, lang: langRef.current });
      prefetchAhead(i);
    },
    [rate, saveProgress, prefetchAhead],
  );

  const playSection = useCallback(
    async (i: number, opts: { startAt?: number; ratio?: number; autoplay?: boolean } = {}) => {
      const a = audioRef.current;
      const b = bookRef.current;
      if (!a || !b || !b.sections[i]) return;
      setErr("");
      interludeRef.current = null;
      setInterlude(null);
      curRef.current = i;
      setCur(i);
      const l = langRef.current;
      const v = voiceRef.current;
      const isReady = l === "he" && readyRef.current.has(i);
      if (!isReady) setLoading(l === "he" ? "מכין את הקטע הזה…" : "מכין את הקטע במקור…");
      try {
        const r = await fetchAudio(i, l, v);
        if (curRef.current !== i) return;
        pendingSeekRatio.current = opts.ratio ?? null;
        a.src = r.url;
        a.playbackRate = rate;
        if (opts.startAt) a.currentTime = opts.startAt;
        if (opts.autoplay !== false) await a.play();
        setLoading("");
        setProg((p) => (p ? { ...p, section: i } : p));
        saveProgress({ section: i, offset: opts.startAt ?? 0, lang: l });
        prefetchAhead(i);
      } catch (e) {
        setLoading("");
        setErr((e as Error).message || "תקלה בהשמעה");
      }
    },
    [fetchAudio, rate, saveProgress],
  );

  // ---- קטעי ביניים: תקציר בחזרה / שאלה בסוף פרק ----
  const playInterlude = useCallback(
    async (kind: "recap" | "question", then: "continue" | "next") => {
      const a = audioRef.current;
      const b = bookRef.current;
      if (!a || !b) return;
      const i = curRef.current;
      try {
        setLoading(kind === "recap" ? "מכין תזכורת קצרה…" : "מכין שאלה לסיום הפרק…");
        const r =
          kind === "recap"
            ? await api<{ text: string; url: string }>(`/api/books/${id}/recap?upto=${i}`)
            : await api<{ text: string; url: string }>(`/api/books/${id}/chapters/${b.sections[i].chapter}/question`);
        setLoading("");
        interludeRef.current = { kind, resume: then === "continue" ? { src: a.src, t: a.currentTime, i } : null, then };
        setInterlude(kind);
        setInterludeText(r.text);
        a.src = r.url;
        a.playbackRate = rate;
        await a.play();
      } catch {
        setLoading("");
        interludeRef.current = null;
        setInterlude(null);
        if (kind === "recap") playSection(i);
        else if (then === "next") playSection(i + 1);
        else a.play().catch(() => {});
      }
    },
    [id, rate, playSection],
  );

  // ---- אירועי הנגן ----
  const onEnded = () => {
    const a = audioRef.current;
    const b = bookRef.current;
    if (!a || !b) return;
    const il = interludeRef.current;
    if (il) {
      interludeRef.current = null;
      if (il.kind === "question") {
        // השקט לחשיבה כבר בתוך קובץ השאלה — ממשיכים מיד לקטע הבא
        continueTo(curRef.current + 1);
        return;
      }
      setInterlude(null);
      if (il.resume) {
        a.src = il.resume.src;
        a.currentTime = il.resume.t;
        a.play().catch(() => {});
      } else playSection(curRef.current);
      return;
    }
    const i = curRef.current;
    const chapterEnd = b.chapters[b.sections[i].chapter]?.end === i;
    if (sleepAt === "chapter" && chapterEnd) {
      setSleepAt(null);
      setPlaying(false);
      return;
    }
    if (i + 1 >= b.sections.length) {
      setPlaying(false);
      return;
    }
    if (chapterEnd && progRef.current?.study && langRef.current === "he") {
      const qUrl = questionUrls.current.get(`${b.sections[i].chapter}:${voiceRef.current}`);
      if (qUrl) {
        // שאלת סוף פרק שכבר הוכנה — מנגנים מיד
        interludeRef.current = { kind: "question", resume: null, then: "next" };
        a.src = qUrl;
        a.playbackRate = rate;
        a.play().catch(() => {
          wantNext.current = i + 1;
        });
        setInterlude("question");
        api<{ text: string; url: string }>(`/api/books/${id}/chapters/${b.sections[i].chapter}/question`).then((r) => setInterludeText(r.text)).catch(() => {});
      } else playInterlude("question", "next");
    } else continueTo(i + 1);
  };
  /** הקטע הבא: מיידי אם הכתובת ידועה, אחרת בדרך הרגילה (ואז נזכור להשלים אם המסך היה כבוי). */
  function continueTo(i: number) {
    const b = bookRef.current;
    if (!b || i >= b.sections.length) return;
    const url = urls.current.get(`${i}:${langRef.current}:${voiceRef.current}`);
    if (url) startKnown(i, url);
    else {
      wantNext.current = i;
      playSection(i).then(() => {
        if (curRef.current === i && !audioRef.current?.paused) wantNext.current = null;
      });
    }
  }
  const onLoaded = () => {
    const a = audioRef.current;
    if (a && pendingSeekRatio.current != null && isFinite(a.duration)) {
      a.currentTime = pendingSeekRatio.current * a.duration;
      pendingSeekRatio.current = null;
    }
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
    if (saveTimer.current == null && !interludeRef.current) {
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const a2 = audioRef.current;
        if (a2 && !a2.paused && !interludeRef.current) saveProgress({ section: curRef.current, offset: Math.floor(a2.currentTime) });
      }, 15000);
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
    if (a && !a.ended && !interludeRef.current) saveProgress({ section: curRef.current, offset: Math.floor(a.currentTime) });
  };

  // ---- Media Session ----
  const goNext = useCallback(() => {
    const b = bookRef.current;
    if (b && curRef.current + 1 < b.sections.length) playSection(curRef.current + 1);
  }, [playSection]);
  const goPrev = useCallback(() => {
    const a = audioRef.current;
    if (a && a.currentTime > 4 && !interludeRef.current) {
      a.currentTime = 0;
      return;
    }
    playSection(Math.max(0, curRef.current - 1));
  }, [playSection]);
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
      if (d.seekTime != null) a.currentTime = d.seekTime;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, cur, goNext, goPrev]);

  // ---- חזרה למסך: אם הקטע נגמר והבא לא התחיל בזמן שהמסך היה כבוי — ממשיכים ----
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const a = audioRef.current;
      if (a && a.paused && wantNext.current != null) {
        const next = wantNext.current;
        wantNext.current = null;
        playSection(next);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [playSection]);

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
      if (pendingRecap.current) {
        pendingRecap.current = false;
        await playInterlude("recap", "next"); // אחרי התקציר מתחיל הקטע הנוכחי
        return;
      }
      await playSection(curRef.current, { startAt: progRef.current?.offset || 0 });
      return;
    }
    if (a.paused) {
      if (wantNext.current != null || a.ended) {
        // הקטע נגמר והבא לא התחיל (מסך כבוי) — ממשיכים ממנו
        const next = wantNext.current ?? curRef.current + 1;
        wantNext.current = null;
        await playSection(next);
        return;
      }
      if (pausedAt.current && Date.now() - pausedAt.current > 60_000 && !interludeRef.current) a.currentTime = Math.max(0, a.currentTime - 5);
      await a.play();
    } else a.pause();
  }
  function jumpToParagraph(i: number, k: number, paras: string[]) {
    const before = paras.slice(0, k).reduce((n, p) => n + p.length + 2, 0);
    const total = paras.reduce((n, p) => n + p.length + 2, 0) || 1;
    playSection(i, { ratio: before / total });
  }
  function changeLang(l: "he" | "orig") {
    if (l === lang) return;
    setLang(l);
    langRef.current = l;
    saveProgress({ lang: l });
    const was = !audioRef.current?.paused;
    playSection(curRef.current, { autoplay: was });
  }
  function changeVoice(v: string) {
    setVoice(v);
    voiceRef.current = v;
    setSheet(null);
    saveProgress({ voice: v });
    cache.current.clear();
    urls.current.clear();
    questionUrls.current.clear();
    setReady(new Set());
    refreshText().then(runPrepare);
    const was = !audioRef.current?.paused;
    if (audioRef.current?.src) playSection(curRef.current, { autoplay: was });
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
  const voiceLabel = voices.find((v) => v.id === voice)?.label.split(" — ")[0] ?? voice;

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
        {interlude && (
          <div className="interlude">
            <div className="pill">{interlude === "recap" ? "תזכורת: מה שמעת עד עכשיו" : "שאלה לסיום הפרק — רגע לחשוב, ואז ממשיכים"}</div>
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
          const a = audioRef.current;
          if (!a || !pos.d) return;
          const r = e.currentTarget.getBoundingClientRect();
          const ratio = 1 - (e.clientX - r.left) / r.width; // RTL
          a.currentTime = ratio * pos.d;
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
              <div key={ci} className={"card clickable row" + (book.sections[cur]?.chapter === ci ? " on" : "")} onClick={() => { setSheet(null); playSection(c.start); }}>
                <div className="grow" dir="auto">{c.title}</div>
                <span className="muted small">{r === n ? "✓" : `${r}/${n}`}</span>
              </div>
            );
          })}
        </div>
      )}
      {sheet === "voice" && (
        <div className="sheet">
          <div className="sheetTitle">קול ההקראה</div>
          <p className="muted small">לחיצה על ▶ משמיעה פסקה מהספר הזה בקול. בחירה מחליפה את הקול לספר הזה (קטעים שכבר הוכנו ייווצרו מחדש ברקע).</p>
          {voices.map((v) => (
            <div key={v.id} className={"card row" + (v.id === voice ? " on" : "")}>
              <button className="iconBtn ghost sm" onClick={() => preview(v.id)} disabled={!!previewing} aria-label="דוגמה">
                {previewing === v.id ? <span className="spinner" /> : "▶"}
              </button>
              <div className="grow">{v.label}</div>
              <button className={v.id === voice ? "primary" : "ghost"} onClick={() => changeVoice(v.id)}>
                {v.id === voice ? "נבחר" : "בחר"}
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
