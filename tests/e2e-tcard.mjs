// בדיקת כרטיס תרגום בדפדפן (מצב דמה): ספר באנגלית → המחקר מתחיל לבד → כרטיס במסך → עריכת מילון → דוגמה →
// "תרגם לפי הכרטיס והאזן" (עברית מאותו מקום) → עריכה נוספת → "תרגם מחדש" (דור חדש) → חזרה למקור → ספר עברי בלי כרטיס.
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
const log = (...a) => console.log("[tcard-e2e]", ...a);
const api = (p, init) =>
  page.evaluate(async ([p, init]) => {
    const pw = localStorage.getItem("app_pw") || "";
    const r = await fetch(p, { ...(init || {}), headers: { "content-type": "application/json", "x-app-password": pw } });
    return r.json();
  }, [p, init]);
const stream = () => page.evaluate(() => { const a = document.querySelector("audio"); const u = new URL(a.dataset.stream || a.src, location.href); return { lang: u.searchParams.get("lang"), gen: u.searchParams.get("gen"), from: u.searchParams.get("from"), paused: a.paused, t: a.currentTime, cur: document.querySelector(".sec.cur")?.id }; });
const playingLang = (lang) => page.waitForFunction((lang) => {
  const a = document.querySelector("audio");
  if (!a || a.paused || a.currentTime < 0.1) return false;
  const u = new URL(a.dataset.stream || a.src, location.href);
  return u.pathname.includes("/stream") && u.searchParams.get("lang") === lang;
}, lang, { timeout: 90000 });

await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/english.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
const bookId = page.url().split("/book/")[1];

// 1. המחקר מתחיל לבד בפתיחת ספר באנגלית
/** בודקים שוב ושוב בקריאה לשרת עד שהתנאי מתקיים. */
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error("timeout: " + what);
    await page.waitForTimeout(500);
  }
}
const ready = await until(async () => { const r = await api(`/api/books/${bookId}/tcard`); return r.state === "ready" ? r : null; }, "card ready");
log("card researched automatically:", ready.card.model, "| glossary", ready.card.glossary.length, "| translated", ready.translated);
if (!ready.card.instructions || !ready.card.translations.length) throw new Error("card should have instructions and translations");

// 2. האזנה במקור, קצת פנימה בתוך הקטע
const chipText = await page.textContent(".chips");
if (chipText.includes("עברית")) throw new Error("new book should start in Hebrew mode (default)");
await page.click("button.chip:has-text('מקור')");
await page.click(".bigPlay");
await playingLang("orig");
await page.waitForTimeout(1500);
await page.evaluate(() => { const a = document.querySelector("audio"); a.currentTime = a.currentTime + 3; });
await page.waitForTimeout(500);
// עוצרים כדי שהקטע לא יתקדם בזמן שעובדים על הכרטיס (קטעי הדמה קצרים)
await page.click(".bigPlay");
await page.waitForFunction(() => document.querySelector("audio").paused);
const inOrig = await stream();
log("listened in original, paused at:", inOrig);

// 3. הכרטיס במסך: ⋯ → כרטיס תרגום
await page.click("button.chip:has-text('⋯')");
await page.waitForSelector("text=כרטיס תרגום");
await page.click(".sheet .card:has-text('כרטיס תרגום') button:has-text('פתח')");
await page.waitForSelector(".tcardSheet .tcardTitle");
const shown = await page.textContent(".tcardSheet");
for (const want of ["מתרגם לדוגמה", "מה אנחנו מחקים", "ביטחון בינוני", "ההנחיות למתרגם", "מילון קבוע", "תרגם לפי הכרטיס והאזן בעברית"]) if (!shown.includes(want)) throw new Error("card sheet missing: " + want);
log("card sheet ok");

// 4. עריכת מילון → שמירה (גרסה חדשה של הכרטיס)
const gloss = page.locator(".tcardText").nth(1);
await gloss.fill((await gloss.inputValue()) + "\nNobody = אף אחד // בדיקה");
await page.click("text=שמור שינויים");
await page.waitForSelector("text=הכרטיס נשמר", { timeout: 10000 });
const afterEdit = await api(`/api/books/${bookId}/tcard`);
if (afterEdit.card.source !== "edit" || !afterEdit.card.glossary.some((g) => g.en === "Nobody" && g.he === "אף אחד" && g.note === "בדיקה")) throw new Error("glossary edit not saved");
log("glossary edit saved as new card version");

// 5. דוגמה מהקטע הנוכחי
await page.click("text=👁 דוגמה: הקטע הנוכחי לפי הכרטיס");
await page.waitForSelector(".tcardSample", { timeout: 30000 });
log("sample:", (await page.textContent(".tcardSample")).slice(0, 60));
const notSaved = await api(`/api/books/${bookId}/tcard`);
if (notSaved.translated !== 0) throw new Error("sample must not be saved as a translation");

// 6. "תרגם לפי הכרטיס והאזן בעברית" — מאותו קטע
await page.click("text=תרגם לפי הכרטיס והאזן בעברית");
await playingLang("he");
const inHe = await stream();
log("now in Hebrew:", inHe);
if (inHe.cur !== inOrig.cur) throw new Error(`should continue in the same section (${inOrig.cur} → ${inHe.cur})`);
if (inHe.gen) throw new Error("no retranslation was asked — no new generation");
if (!(await page.textContent(".chips")).includes("מקור")) throw new Error("language chip should now offer the original");
const t1 = await api(`/api/books/${bookId}/tcard`);
log("translated after apply:", t1.translated, "older:", t1.older);
if (t1.translated < 1 || t1.older !== 0) throw new Error("the current section should be translated by the current card");

// 7. עריכה נוספת → מה שתורגם נחשב "לפני הכרטיס" → "תרגם מחדש" פותח דור חדש
await page.click(".bigPlay");
await page.waitForFunction(() => document.querySelector("audio").paused);
const beforeRe = await stream();
await page.click("button.chip:has-text('⋯')");
await page.click(".sheet .card:has-text('כרטיס תרגום') button:has-text('פתח')");
await page.waitForSelector(".tcardSheet .tcardText");
const instr = page.locator(".tcardText").nth(0);
await instr.fill((await instr.inputValue()) + "\nהנחיה נוספת לבדיקה");
await page.click("text=שמור שינויים");
await page.waitForSelector("text=תרגם מחדש לפי הכרטיס והאזן", { timeout: 10000 });
log("older translations offered for retranslation:", (await page.textContent(".tcardSheet")).match(/(\d+) קטעים כבר תורגמו/)?.[1]);
await page.click("text=תרגם מחדש לפי הכרטיס והאזן");
await page.waitForFunction(() => { const a = document.querySelector("audio"); const u = new URL(a.dataset.stream || a.src, location.href); return !a.paused && !!u.searchParams.get("gen"); }, null, { timeout: 90000 });
const reg = await stream();
const t2 = await api(`/api/books/${bookId}/tcard`);
log("retranslated — new generation:", reg.gen, "| server gen", t2.gen, "| translated in new gen", t2.translated);
if (!t2.gen || reg.gen !== t2.gen) throw new Error("stream should carry the new generation");
if (reg.cur !== beforeRe.cur) throw new Error(`retranslation should restart at the same section (${beforeRe.cur} → ${reg.cur})`);
const text = await api(`/api/books/${bookId}/text?lang=he`);
if (!text.ready.includes(Number(reg.cur.slice(2)))) throw new Error("current section should be ready in the new generation");

// 8. חזרה למקור — אותו קטע
await page.click(".bigPlay");
await page.waitForFunction(() => document.querySelector("audio").paused);
const beforeBack = await stream();
await page.click("button.chip:has-text('מקור')");
await page.waitForFunction(() => { const a = document.querySelector("audio"); return new URL(a.dataset.stream || a.src, location.href).searchParams.get("lang") === "orig"; }, null, { timeout: 60000 });
await page.click(".bigPlay");
await playingLang("orig");
const back = await stream();
log("back to original:", back);
if (back.cur !== beforeBack.cur) throw new Error(`switching back should keep the section (${beforeBack.cur} → ${back.cur})`);

// 9. ספר עברי — אין כרטיס תרגום בתפריט
await page.goto(BASE);
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/hebrew.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
await page.click("button.chip:has-text('⋯')");
await page.waitForSelector("text=מה פספסתי?");
if (await page.$("text=כרטיס תרגום")) throw new Error("Hebrew book should not offer a translation card");
log("hebrew book: no card ok");
await page.screenshot({ path: "tests/out/tcard.png" });

const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) {
  console.log("ERRORS:\n" + real.join("\n"));
  process.exit(1);
}
log("TCARD E2E OK");
await browser.close();
