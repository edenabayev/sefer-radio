// PDF עם שכבת טקסט בדפדפן (שרת אמיתי בבנייה, מצב דמה): העלאה → נקרא כאן על השרת (בלי גוגל) → פרקים ופסקאות → השמעה.
import { chromium, devices } from "playwright";
import path from "path";
import fs from "fs";

const BASE = process.env.BASE || "http://localhost:3123";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "he-IL" });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("response", (r) => r.status() >= 400 && errors.push(`http ${r.status()} ${r.url()}`));
const log = (...a) => console.log("[pdf-e2e]", ...a);

await page.goto(BASE);
await page.waitForSelector("text=הספרים שלי");
await page.click("text=הוסף ספר משלי");
await page.setInputFiles('input[type="file"]', path.resolve("tests/fixtures/textlayer.pdf"));
await page.waitForURL(/\/book\//, { timeout: 60000 });
await page.waitForSelector(".sec", { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll("h2.chapterHead").length >= 3, null, { timeout: 30000 });
const heads = await page.$$eval("h2.chapterHead", (els) => els.map((e) => e.textContent.trim()));
const paras = await page.$$eval(".para", (els) => els.map((e) => e.textContent.trim()));
log("chapters:", heads.join(" | "), "| paragraphs:", paras.length);
if (heads.join("|") !== "Chapter 1|Chapter 2|Chapter 3") throw new Error("chapters from the PDF headings");
if (paras.length !== 27 || !paras.every((p) => /^Paragraph \d\.\d+ begins here\..*and so ends paragraph \d\.\d+\.$/.test(p))) throw new Error("27 whole paragraphs expected");
if (paras.some((p) => p.includes("TEXT LAYER BOOK"))) throw new Error("running header leaked");
// לא עבר לגוגל (בדמה גוגל היה מחזיר "זהו טקסט דמה")
if (paras.some((p) => p.includes("טקסט דמה"))) throw new Error("should be read locally, not by the AI");
await page.click(".bigPlay");
await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 60000 });
log("playing ok");
const srv = fs.existsSync("/tmp/claude-0/srv.log") ? fs.readFileSync("/tmp/claude-0/srv.log", "utf8") : "";
if (/local pdf text/.test(srv)) throw new Error("local reader failed on the server: " + srv.match(/local pdf text.*/)[0]);
const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) {
  console.log("ERRORS:\n" + real.join("\n"));
  process.exit(1);
}
log("PDF E2E OK");
await browser.close();
