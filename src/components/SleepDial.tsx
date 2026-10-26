"use client";
// חוגת שעון שינה, כמו טיימר מטבח: מסובבים את הטבעת (כל סיבוב = שעה, אפשר להמשיך לסיבוב שני),
// משחררים — והטיימר רץ. בזמן ריצה הטבעת מתרוקנת; אפשר לסובב שוב כדי לשנות, או לסובב עד האפס כדי לכבות.
import { useEffect, useRef, useState } from "react";

const SIZE = 260;
const CX = SIZE / 2;
const R = 100;
const STROKE = 18;
const C = 2 * Math.PI * R;
const MAX_MIN = 120;
const DEG_PER_MIN = 6; // 360° = 60 דקות

interface Props {
  /** בזמן ריצה: הדקות שנשארו (עם שבר). בלי ריצה: לא בשימוש. */
  remaining?: number;
  running: boolean;
  initial: number;
  /** משחררים את האצבע: מספר הדקות שנבחר (0 = לכבות). */
  onCommit: (minutes: number) => void;
}

function arcOffset(minutesInLap: number) {
  return C * (1 - Math.max(0, Math.min(60, minutesInLap)) / 60);
}

function fmtLeft(m: number) {
  const s = Math.max(0, Math.round(m * 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function clockAfter(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

export default function SleepDial({ remaining, running, initial, onCommit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState(false);
  const [value, setValue] = useState(initial); // דקות שלמות בזמן גרירה / בחירה
  const st = useRef({ last: 0, total: initial * DEG_PER_MIN, value: initial });

  // כשהטיימר רץ ולא גוררים — הטבעת מראה את הזמן שנשאר
  const shown = drag || !running ? value : Math.max(0, remaining ?? 0);

  useEffect(() => {
    if (!drag && running && remaining != null) {
      st.current.total = remaining * DEG_PER_MIN;
    }
  }, [drag, running, remaining]);

  // הטיימר כבה (נגמר, בוטל, או סובב לאפס) — החוגה חוזרת לזמן האחרון שבחרת
  useEffect(() => {
    if (!running && !drag) {
      const v = initial > 0 ? initial : 15;
      st.current = { last: 0, total: v * DEG_PER_MIN, value: v };
      setValue(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const angleOf = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = clientX - (r.left + r.width / 2);
    const y = clientY - (r.top + r.height / 2);
    return ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  };

  const setFromTotal = (total: number) => {
    const t = Math.max(0, Math.min(MAX_MIN * DEG_PER_MIN, total));
    st.current.total = t;
    const m = Math.round(t / DEG_PER_MIN);
    if (m !== st.current.value) {
      st.current.value = m;
      setValue(m);
      try {
        navigator.vibrate?.(4);
      } catch {
        /* אין רטט */
      }
    }
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const a = angleOf(e.clientX, e.clientY);
    st.current.last = a;
    if (running && remaining != null) {
      st.current.value = Math.round(remaining);
      st.current.total = remaining * DEG_PER_MIN;
      setValue(st.current.value);
    }
    // בסיבוב הראשון: לחיצה על הטבעת קופצת ישר לנקודה שנגעת בה
    if (st.current.total < 360) setFromTotal(a);
    setDrag(true);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const a = angleOf(e.clientX, e.clientY);
    let d = a - st.current.last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    st.current.last = a;
    setFromTotal(st.current.total + d);
  };
  const onUp = () => {
    if (!drag) return;
    setDrag(false);
    onCommit(st.current.value);
  };

  const lap1 = Math.min(60, shown);
  const lap2 = Math.max(0, shown - 60);
  const knobDeg = ((shown % 60) / 60) * 360 + (shown >= 60 && shown % 60 === 0 ? 360 : 0);
  const kx = CX + R * Math.sin((knobDeg * Math.PI) / 180);
  const ky = CX - R * Math.cos((knobDeg * Math.PI) / 180);
  const animate = !drag;

  return (
    <div className={"sleepDial" + (running ? " running" : "") + (drag ? " dragging" : "")}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width="100%"
        style={{ maxWidth: SIZE, touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="slider"
        aria-label="שעון שינה בדקות"
        aria-valuemin={0}
        aria-valuemax={MAX_MIN}
        aria-valuenow={Math.round(shown)}
      >
        <defs>
          <radialGradient id="dialGlow" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle className="dialHalo" cx={CX} cy={CX} r={R + 26} fill="url(#dialGlow)" />
        {/* שנתות: כל דקה קטנה, כל חמש גדולה */}
        {Array.from({ length: 60 }, (_, k) => {
          const big = k % 5 === 0;
          const a = (k / 60) * 2 * Math.PI;
          const r1 = R + STROKE / 2 + 4;
          const r2 = r1 + (big ? 9 : 4);
          return (
            <line
              key={k}
              x1={CX + r1 * Math.sin(a)}
              y1={CX - r1 * Math.cos(a)}
              x2={CX + r2 * Math.sin(a)}
              y2={CX - r2 * Math.cos(a)}
              className={big ? "tick big" : "tick"}
            />
          );
        })}
        {[0, 15, 30, 45].map((m) => {
          const a = (m / 60) * 2 * Math.PI;
          const r = R - STROKE / 2 - 14;
          return (
            <text key={m} x={CX + r * Math.sin(a)} y={CX - r * Math.cos(a) + 4} className="dialLabel" textAnchor="middle">
              {m}
            </text>
          );
        })}
        <circle cx={CX} cy={CX} r={R} className="dialTrack" strokeWidth={STROKE} fill="none" />
        <circle
          cx={CX}
          cy={CX}
          r={R}
          className="dialArc"
          strokeWidth={STROKE}
          fill="none"
          strokeDasharray={C}
          strokeDashoffset={arcOffset(lap1)}
          transform={`rotate(-90 ${CX} ${CX})`}
          style={{ transition: animate ? (running ? "stroke-dashoffset 1s linear" : "stroke-dashoffset .35s ease") : "none" }}
        />
        {lap2 > 0 && (
          <circle
            cx={CX}
            cy={CX}
            r={R}
            className="dialArc lap2"
            strokeWidth={STROKE - 8}
            fill="none"
            strokeDasharray={C}
            strokeDashoffset={arcOffset(lap2)}
            transform={`rotate(-90 ${CX} ${CX})`}
            style={{ transition: animate ? "stroke-dashoffset .35s ease" : "none" }}
          />
        )}
        <circle cx={kx} cy={ky} r={STROKE / 2 + 5} className="dialKnob" style={{ transition: animate ? "cx .35s ease, cy .35s ease" : "none" }} />
        <text x={CX} y={CX + 6} className="dialValue" textAnchor="middle">
          {running && !drag ? fmtLeft(shown) : Math.round(shown)}
        </text>
        <text x={CX} y={CX + 32} className="dialUnit" textAnchor="middle">
          {running && !drag ? `עד ${clockAfter(shown)}` : shown === 0 ? "כבוי" : `דקות · עד ${clockAfter(shown)}`}
        </text>
      </svg>
      <div className="muted small dialHint">
        {drag
          ? shown === 0
            ? "שחרר כדי לכבות"
            : "שחרר כדי להפעיל"
          : running
            ? "סובב כדי לשנות · עד האפס כדי לכבות"
            : "סובב את הטבעת — סיבוב שלם = שעה"}
      </div>
    </div>
  );
}
