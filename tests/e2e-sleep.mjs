// בדיקת שעון שינה בדפדפן (מצב דמה): חוגה → טיימר רץ → דעיכה → עצירה → "איפה נרדמת?" → "מה פספסתי?" →
// בחירת פסקה → ממשיכים משם; סיבוב החוגה לאפס מכבה; "עד סוף הפרק".
import { chromium, devices } from "playwright";
import path from "path";

const BASE = process.env.BASE || "http://localhost:3123";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "he-IL" });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("response", (r) => r.status() >= 400 && errors.push(`http ${r.status()} ${r.url()}`));
const log = (...a) => console.log("[sleep-e2e]", ...a);
const playing = () => page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 60000 });
const state = () => page.evaluate(() => { const a = document.querySelector("audio"); return { paused: a.paused, volume: +a.volume.toFixed(2), cur: document.querySelector(".sec.cur")?.id, chip: document.querySelector('[aria-label="שעון שינה"]')?.textContent?.trim() }; });
const api = (p, init) => page.evaluate(async ([p, init]) => {
  const pw = localStorage.getItem("app_pw") || "";
  const r = await fetch(p, { ...(init || {}), headers: { "content-type": "application/json", "x-app-password": pw } });
  return r.json();
}, [p, init]);

/** גרירה על החוגה: מהשעה 12 עם כיוון השעון עד הזווית שמתאימה ל-minutes. */
async function dial(minutes) {
  const box = await page.locator(".sleepDial svg").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = (box.width / 260) * 100;
  const at = (deg) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
  const [x0, y0] = at(1);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const target = minutes * 6;
  const steps = Math.max(4, Math.ceil(Math.abs(target) / 4));
  for (let k = 1; k <= steps; k++) {
    const [x, y] = at(1 + ((target - 1) * k) / steps);
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
}

await page.clock.install();
await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/hebrew.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
const bookId = page.url().split("/book/")[1];
await page.click(".bigPlay");
await playing();
log("playing", await state());

// 1. החוגה: 2 דקות
await page.click('[aria-label="שעון שינה"]');
await page.waitForSelector(".sleepDial svg");
await dial(2);
await page.waitForFunction(() => /\d:\d\d/.test(document.querySelector('[aria-label="שעון שינה"]')?.textContent || ""), null, { timeout: 5000 });
const s1 = await state();
log("timer set:", s1.chip);
if (!/^😴 (1:5\d|2:00)$/.test(s1.chip)) throw new Error("expected ~2:00 countdown, got " + s1.chip);
const sess = await page.waitForFunction(async (id) => {
  const pw = localStorage.getItem("app_pw") || "";
  const r = await fetch(`/api/books/${id}/sleep`, { headers: { "x-app-password": pw } }).then((x) => x.json());
  return r.session && !r.session.cancelled ? r.session : null;
}, bookId, { timeout: 10000, polling: 500 }).then((h) => h.jsonValue());
log("server session:", sess.id, "minutes", sess.minutes, "section", sess.section);
if (sess.minutes !== 2) throw new Error("server session minutes should be 2");
await page.mouse.click(20, 60); // סוגרים את הגיליון בלחיצה מעליו

// ממשיכים להאזין קצת בזמן אמת, כדי שתהיה "התקדמות" בלילה (קטע דמה ~10 שניות)
await page.waitForTimeout(14000);

// 2. דעיכה בדקה האחרונה
await page.clock.fastForward("01:30");
await page.waitForTimeout(1500);
const s2 = await state();
log("fading:", s2);
if (!(s2.volume < 0.7) || s2.paused) throw new Error("expected fade while playing");

// 3. עצירה
await page.clock.fastForward("00:30");
await page.waitForFunction(() => document.querySelector("audio").paused, null, { timeout: 5000 });
const s3 = await state();
log("fired:", s3);
if (s3.chip !== "😴" || s3.volume !== 1) throw new Error("timer should be cleared and volume restored");
const night = await page.waitForFunction(async (id) => {
  const pw = localStorage.getItem("app_pw") || "";
  const r = await fetch(`/api/books/${id}/sleep`, { headers: { "x-app-password": pw } }).then((x) => x.json());
  return r.pending ? r : null;
}, bookId, { timeout: 10000, polling: 500 }).then((h) => h.jsonValue());
log("night pending:", night.paragraphs.length, "paragraphs, end", night.end);
if (!night.paragraphs.length) throw new Error("night should have paragraphs");

// 4. ▶ אחרי עצירה → "איפה נרדמת?"
await page.click(".bigPlay");
await page.waitForSelector("text=איפה נרדמת?", { timeout: 10000 });
const items = await page.$$eval(".nightItem", (els) => els.map((e) => e.textContent));
log("night list:", items.length, "first:", items[0]?.slice(0, 40));
if (items.length !== night.paragraphs.length) throw new Error("night list length mismatch");
const wasPaused = await page.evaluate(() => document.querySelector("audio").paused);
if (!wasPaused) throw new Error("should not resume before choosing");

// 5. "מה פספסתי?" → סיכום מוקרא, המסך נשאר פתוח
await page.click("text=🌙 מה פספסתי?");
await page.waitForSelector(".missedBox", { timeout: 30000 });
await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.dataset.stream === ""; }, null, { timeout: 30000 });
log("missed summary playing:", (await page.textContent(".missedBox")).slice(0, 50));
// הסיכום נגמר כשהמסך פתוח → לא ממשיכים לבד
await page.evaluate(() => { const a = document.querySelector("audio"); a.currentTime = a.duration - 0.1; });
await page.waitForFunction(() => document.querySelector("audio").paused, null, { timeout: 10000 });
await page.waitForTimeout(1500);
if (!(await page.evaluate(() => document.querySelector("audio").paused))) throw new Error("should wait for a choice after the summary");
if (!(await page.$("text=איפה נרדמת?"))) throw new Error("night sheet should stay open");

// 6. בחירת פסקה → ממשיכים משם, והלילה נסגר
const pick = night.paragraphs[Math.min(1, night.paragraphs.length - 1)];
await page.click(`.nightItem >> nth=${Math.min(1, night.paragraphs.length - 1)}`);
await page.waitForFunction((n) => { const a = document.querySelector("audio"); return document.querySelector(".sec.cur")?.id === "s-" + n && a && !a.paused && (a.dataset.stream || "").includes("/stream"); }, pick.section, { timeout: 30000 });
log("resumed at picked paragraph:", await state());
const after = await api(`/api/books/${bookId}/sleep`);
if (after.pending) throw new Error("night should be resolved after choosing");

// 7. סיבוב לאפס מכבה
await page.click('[aria-label="שעון שינה"]');
await dial(3);
await page.waitForFunction(() => /\d:\d\d/.test(document.querySelector('[aria-label="שעון שינה"]')?.textContent || ""), null, { timeout: 5000 });
const box = await page.locator(".sleepDial svg").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = (box.width / 260) * 100;
const at = (deg) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
await page.mouse.move(...at(18));
await page.mouse.down();
for (let d = 16; d >= -10; d -= 2) await page.mouse.move(...at(d < 0 ? 360 + d : d));
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('[aria-label="שעון שינה"]')?.textContent?.trim() === "😴", null, { timeout: 5000 });
const cancelled = await api(`/api/books/${bookId}/sleep`);
if (!cancelled.session?.cancelled) throw new Error("dial to zero should cancel the server session");
log("dial to zero cancels: ok");

// 8. עד סוף הפרק
await page.click("text=עד סוף הפרק");
await page.waitForFunction(() => document.querySelector('[aria-label="שעון שינה"]')?.textContent?.includes("סוף פרק"), null, { timeout: 5000 });
await page.click("text=כבה");
await page.waitForFunction(() => document.querySelector('[aria-label="שעון שינה"]')?.textContent?.trim() === "😴", null, { timeout: 5000 });
log("chapter mode + off: ok");
const back = await page.textContent(".sleepDial .dialValue");
if (back.trim() !== "3") throw new Error("after turning off, the dial should return to the last time (3), got " + back);
await page.screenshot({ path: "tests/out/sleep.png" });

const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) {
  console.log("ERRORS:\n" + real.join("\n"));
  process.exit(1);
}
log("SLEEP E2E OK");
await browser.close();
