import { chromium } from "@playwright/test";
const b = await chromium.launch();
for (const [name, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }], ["tablet", { width: 820, height: 1100 }]]) {
  const p = await (await b.newContext({ viewport: vp })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:3250/", { waitUntil: "networkidle", timeout: 90000 });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${process.env.OUT}/hero2-${name}.png`, fullPage: name === "phone" });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(name, "horizontal overflow:", overflow, "errors:", errs.length);
}
await b.close();
