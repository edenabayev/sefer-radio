// רשימת הקולות של Kokoro (אנגלית) — מודול קל, בלי טעינת המודל עצמו.
export const KOKORO_VERSION = "kk3"; // kk3: מ-26.10 (לילה) — בלי כותרות רצות ובלי "נשימה" בפסקה שנשברה באמצע משפט; kk2: צינור ההקראה (15.10). משתנה כשמשנים את אופן ההפקה
export const KOKORO_VOICES = [
  { id: "am_michael", label: "Michael — אמריקאי, רגוע" },
  { id: "am_fenrir", label: "Fenrir — אמריקאי, עמוק" },
  { id: "am_puck", label: "Puck — אמריקאי, קליל" },
  { id: "bm_george", label: "George — בריטי" },
  { id: "bm_lewis", label: "Lewis — בריטי" },
  { id: "af_heart", label: "Heart — אמריקאית" },
  { id: "af_bella", label: "Bella — אמריקאית" },
  { id: "af_nicole", label: "Nicole — אמריקאית, שקטה" },
  { id: "bf_emma", label: "Emma — בריטית" },
];
export const KOKORO_DEFAULT = "am_michael";
export const isKokoroVoice = (v: string | undefined | null): v is string => !!v && KOKORO_VOICES.some((k) => k.id === v);
export const kokoroVoice = (v: string | undefined | null) => (isKokoroVoice(v) ? v : KOKORO_DEFAULT);
