import { chromium, devices } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ ...devices["Pixel 7"] });
const page = await ctx.newPage();
page.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 200)));
await page.goto("http://localhost:3123/book/ua65694ae99fd");
await page.waitForSelector(".bigPlay:not([disabled])");
await page.click(".bigPlay");
await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.currentTime > 0.2; });
await page.evaluate(() => { const a = document.querySelector("audio"); a.addEventListener("ended", () => console.log("ENDED fired")); a.addEventListener("seeked", () => console.log("seeked", a.currentTime)); a.currentTime = a.duration - 0.2; });
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1000);
  console.log(await page.evaluate(() => { const a = document.querySelector("audio"); return { t: a.currentTime, d: a.duration, paused: a.paused, ended: a.ended, pill: document.querySelector(".pill")?.textContent, status: document.querySelector(".status")?.textContent }; }));
}
await browser.close();
