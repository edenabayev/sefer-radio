// בדיקת זרימה מלאה בדפדפן (מצב דמה): העלאה → נגן → השמעה → הסבר → קטע הבא → מעבר שפה → PDF בצעדים.
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

function log(...a) {
  console.log("[e2e]", ...a);
}
async function audioState() {
  return page.evaluate(() => {
    const a = document.querySelector("audio");
    return { src: a?.src?.slice(-60), paused: a?.paused, t: a?.currentTime, d: a?.duration, rate: a?.playbackRate };
  });
}

// 1. ספרייה
await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
log("library ok");

// 2. העלאת טקסט אנגלי
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/english.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
const title = await page.textContent(".title");
log("book page:", title);
const pill = await page.textContent(".pill");
log("pill:", pill);

// 3. השמעה (מדליקים מצב לימוד כדי לבדוק גם את ההסבר)
await page.click("text=מצב לימוד: כבוי");
await page.waitForSelector("text=מצב לימוד: פועל");
await page.click(".bigPlay");
await page.waitForFunction(() => {
  const a = document.querySelector("audio");
  return a && !a.paused && a.currentTime > 0.2;
}, null, { timeout: 60000 });
log("playing:", await audioState());
const text1 = await page.textContent(".sectionText");
log("text starts:", text1.slice(0, 60));
if (!text1.startsWith("[דמה]")) throw new Error("expected mock Hebrew translation text");

// 4. סיום הקטע → הסבר (מצב לימוד פועל)
await page.evaluate(() => {
  const a = document.querySelector("audio");
  a.currentTime = a.duration - 0.2;
});
await page.waitForSelector("text=הסבר של המורה", { timeout: 60000 });
await page.waitForFunction(() => !document.querySelector("audio").paused, null, { timeout: 60000 });
log("explanation playing:", await audioState());

// 5. סיום ההסבר → קטע 2
await page.evaluate(() => {
  const a = document.querySelector("audio");
  a.currentTime = a.duration - 0.2;
});
await page.waitForFunction(() => document.querySelector(".pill")?.textContent?.includes("קטע 2"), null, { timeout: 60000 });
await page.waitForFunction(() => !document.querySelector("audio").paused, null, { timeout: 60000 });
log("section 2 playing:", await page.textContent(".pill"));

// 6. מעבר למקור (אנגלית)
await page.click("text=מקור");
await page.waitForFunction(() => document.querySelector(".sectionText")?.classList.contains("ltr"), null, { timeout: 60000 });
await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.src.includes("%2Fen%2F"); }, null, { timeout: 60000 });
const orig = await page.textContent(".sectionText");
log("orig text:", orig.slice(0, 50));
if (orig.startsWith("[דמה]")) throw new Error("orig should be English");

// 7. כיבוי מצב לימוד, הקטע הבא דרך כפתור
await page.click("text=מצב לימוד: פועל");
await page.waitForSelector("text=מצב לימוד: כבוי");
await page.click('button[aria-label="הקטע הבא"]');
await page.waitForFunction(() => document.querySelector(".pill")?.textContent?.includes("קטע 3"), null, { timeout: 60000 });
log("next button ok");

// 8. השהיה ושמירת מקום, חזרה לספרייה ובחזרה — ממשיך מאותו קטע
await page.click(".bigPlay"); // pause
await page.waitForTimeout(500);
const url = page.url();
await page.goto(BASE);
await page.waitForSelector(".card.clickable");
await page.goto(url);
await page.waitForSelector(".bigPlay:not([disabled])");
await page.waitForFunction(() => document.querySelector(".pill")?.textContent?.includes("קטע 3"), null, { timeout: 30000 });
log("resume ok:", await page.textContent(".pill"));

// 9. ספר בעברית — בלי כפתורי שפה, הטקסט המקורי מוקרא
await page.goto(BASE);
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/hebrew.txt"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".bigPlay:not([disabled])");
if ((await page.$("text=מקור")) !== null) throw new Error("hebrew book should not show language toggle");
await page.click(".bigPlay");
await page.waitForFunction(() => !document.querySelector("audio").paused, null, { timeout: 60000 });
const heText = await page.textContent(".sectionText");
if (heText.startsWith("[דמה]")) throw new Error("hebrew book should not be 'translated'");
log("hebrew book ok:", heText.slice(0, 30));

// 10. PDF — קריאה בצעדים
await page.goto(BASE);
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/test.pdf"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForFunction(() => (document.querySelector(".pill")?.textContent || "").match(/\/ [1-9]/), null, { timeout: 120000 });
await page.waitForSelector(".bigPlay:not([disabled])");
await page.click(".bigPlay");
await page.waitForFunction(() => !document.querySelector("audio").paused, null, { timeout: 60000 });
log("pdf book ok:", await page.textContent(".pill"));

// 11. ספרייה מציגה שלושה ספרים
await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
const cards = await page.$$eval(".card.clickable", (els) => els.length);
log("library books:", cards);
if (cards < 3) throw new Error("expected 3 books in library");

await page.screenshot({ path: "tests/out/library.png", fullPage: true });
await page.goto(url);
await page.waitForSelector(".bigPlay");
await page.screenshot({ path: "tests/out/player.png", fullPage: true });

const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) {
  console.log("ERRORS:\n" + real.join("\n"));
  process.exit(1);
}
log("E2E OK");
await browser.close();
