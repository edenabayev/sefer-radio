// בדיקת זרימה מלאה בדפדפן (מצב דמה): העלאה → דף ספר → השמעה → פסקה מסומנת → קפיצה בלחיצה →
// שאלה בסוף פרק → קטע הבא → מעבר שפה → בחירת קול → המשך מאותו מקום → ספר עברי → PDF → ספרייה.
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
const log = (...a) => console.log("[e2e]", ...a);
const audio = () => page.evaluate(() => { const a = document.querySelector("audio"); return { src: (a?.dataset.stream || a?.src)?.slice(-50), paused: a?.paused, t: a?.currentTime, d: a?.duration }; });
const playing = () => page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 60000 });
// מדלגים לסוף הקטע הנוכחי בתוך הזרם הרציף (לפי המניפסט)
const finish = () => page.evaluate(async () => {
  const a = document.querySelector("audio");
  const u = new URL(a.dataset.stream || a.src, location.href);
  if (!u.pathname.includes("/stream")) { a.currentTime = a.duration - 0.15; return; }
  const pw = localStorage.getItem("app_pw") || "";
  const id = u.pathname.split("/")[3];
  const m = await fetch(`/api/books/${id}/stream/manifest?${u.searchParams.toString()}`, { headers: { "x-app-password": pw } }).then((r) => r.json());
  const it = m.items.filter((x) => x.start <= a.currentTime + 0.05).pop();
  a.currentTime = it.start + it.seconds - 0.15;
});
const header = () => page.textContent(".readerTop");
// הקטע n מתנגן בפועל: מסומן על המסך וגם נמצא בתוך הזרם שבנגן
const atSection = (n) => page.waitForFunction((n) => {
  const a = document.querySelector("audio");
  if (document.querySelector(".sec.cur")?.id !== "s-" + n || !a || a.paused) return false;
  const u = new URL(a.dataset.stream || a.src, location.href);
  if (!u.pathname.includes("/stream")) return true;
  const from = Number(u.searchParams.get("from")), upto = Number(u.searchParams.get("upto"));
  return from <= n && n <= upto;
}, n, { timeout: 60000 });

await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
log("library ok");

// העלאת טקסט אנגלי
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/english.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
await page.waitForSelector(".sec");
log("book page:", (await header()).slice(0, 60));

// לפני ▶ הראשון לא מכינים כלום (כלל עדן)
await page.waitForTimeout(3000);
if ((await page.$$eval(".sec:not(.notReady)", (els) => els.length)) !== 0) throw new Error("nothing should be prepared before first play");

// השמעה + פסקה מסומנת
await page.click(".bigPlay");
await playing();
await page.waitForSelector(".para.now", { timeout: 30000 });
log("playing, highlighted para in section", await page.$eval(".sec.cur", (el) => el.id));

// מרגע ▶ הראשון ההכנה ברקע רצה — מחכים שכל הקטעים יהיו מוכנים (ספר קצר במצב דמה)
await page.waitForFunction(() => document.querySelectorAll(".sec:not(.notReady)").length >= 1, null, { timeout: 90000 });
log("prepared sections:", await page.$$eval(".sec:not(.notReady)", (els) => els.length));
const heText = await page.$eval(".sec.cur .para", (el) => el.textContent);
if (!heText.startsWith("[דמה]")) throw new Error("expected Hebrew (mock) text in current section");

// קפיצה בלחיצה על פסקה בקטע אחר
await page.click("#s-3 .para");
await atSection(3);
log("tap-to-jump ok:", await audio());

// סוף פרק: שאלה (מצב לימוד שקט פועל כברירת מחדל) ואז הקטע הבא
const chapterEnd = await page.evaluate(() => { const first = document.querySelector("section"); const ids = [...first.querySelectorAll(".sec")].map((d) => Number(d.id.slice(2))); return Math.max(...ids); });
await page.click(`#s-${chapterEnd} .para`);
await atSection(chapterEnd);
await finish();
await page.waitForSelector("text=שאלה לסיום הפרק", { timeout: 60000 });
log("chapter question shown");
await playing();
await finish();
// השקט לחשיבה נמצא בתוך קובץ השאלה; בסופו ממשיכים מיד לקטע הבא
await atSection(chapterEnd + 1);
log("continued to next chapter:", await page.$eval(".sec.cur", (el) => el.id));

// מעבר למקור
await page.click("text=מקור");
await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && (a.dataset.stream || a.src).includes("lang=orig"); }, null, { timeout: 60000 });
const orig = await page.$eval(".sec.cur .para", (el) => el.textContent);
if (orig.startsWith("[דמה]")) throw new Error("orig should be English");
log("orig ok");
await page.click("text=עברית");
await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && (a.dataset.stream || a.src).includes("lang=he"); }, null, { timeout: 60000 });

// בחירת קול: פותחים את הגיליון ובוחרים קול אחר
await page.click("text=🗣");
await page.waitForSelector(".sheetTitle");
const before = (await audio()).src;
await page.click(".sheet .card:nth-of-type(2) button:last-child");
await page.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 10000 });
await page.waitForFunction((b) => { const a = document.querySelector("audio"); return a && (a.dataset.stream || a.src).slice(-50) !== b && (a.dataset.stream || a.src).includes("lang=he") && !(a.dataset.stream || a.src).includes("voice=Puck"); }, before, { timeout: 60000 });
log("voice changed:", await audio());

// השהיה, שמירת מקום, חזרה
await page.click(".bigPlay");
await page.waitForTimeout(400);
const url = page.url();
const curId = await page.$eval(".sec.cur", (el) => el.id);
await page.goto(BASE);
await page.waitForSelector(".continueCard");
await page.goto(url);
await page.waitForSelector(".bigPlay:not([disabled])");
await page.waitForFunction((id) => document.querySelector(".sec.cur")?.id === id, curId, { timeout: 30000 });
log("resume ok:", curId);

// ספר עברי
await page.goto(BASE);
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/hebrew.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
if ((await page.$("text=מקור")) !== null) throw new Error("hebrew book should not show language toggle");
await page.click(".bigPlay");
await playing();
log("hebrew book ok");

// PDF בצעדים
await page.goto(BASE);
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/test.pdf"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".sec", { timeout: 120000 });
await page.waitForSelector(".bigPlay:not([disabled])");
await page.click(".bigPlay");
await playing();
log("pdf book ok");

await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
const cards = await page.$$eval(".card.clickable:not(.continueCard)", (els) => els.length);
if (cards < 3) throw new Error("expected 3 books");
await page.screenshot({ path: "tests/out/library.png", fullPage: true });
await page.goto(url);
await page.waitForSelector(".bigPlay");
await page.waitForTimeout(800);
await page.screenshot({ path: "tests/out/player.png", fullPage: false });

// פתקים: דרך ה-API (כמו שהשיחה שומרת) ואז בגיליון הפתקים
const bookId = url.split("/book/")[1];
const pw = await page.evaluate(() => localStorage.getItem("app_pw") || "");
const saved = await page.evaluate(async ([id, pw]) => {
  const r = await fetch(`/api/books/${id}/notes`, { method: "POST", headers: { "content-type": "application/json", "x-app-password": pw }, body: JSON.stringify({ section: 0, title: "פתק בדיקה", text: "החופש הוא אחריות" }) });
  return (await r.json());
}, [bookId, pw]);
if (!saved?.note?.id && !saved?.data?.note?.id) throw new Error("note not saved: " + JSON.stringify(saved));
await page.reload();
await page.waitForSelector(".bigPlay");
await page.click("text=פתקים");
await page.waitForSelector("text=פתק בדיקה");
await page.screenshot({ path: "tests/out/notes.png", fullPage: false });
await page.click('[aria-label="מחק פתק"]');
await page.waitForFunction(() => !document.body.textContent.includes("פתק בדיקה"));
log("notes ok");

const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) {
  console.log("ERRORS:\n" + real.join("\n"));
  process.exit(1);
}
log("E2E OK");
await browser.close();
