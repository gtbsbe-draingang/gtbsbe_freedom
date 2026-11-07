// The app mounts, shows its title and uses the inlined font under the strict CSP.
import assert from "node:assert/strict";

export const name = "smoke";
export const path = "/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

export async function run(page) {
  await page.waitFor(".cqa");
  assert.match(await page.text(".cqa"), /Qualio/);

  // Light theme by default.
  assert.equal(await page.count(".cqa--dark"), 0);
  assert.equal(await page.eval(`getComputedStyle(document.querySelector(".cqa")).backgroundColor`), "rgb(245, 246, 247)");

  // The font comes from a data: URL in app.css; load() rejects if the CSP or the data is bad.
  const faces = await page.eval(`document.fonts.load('14px "CoFo Sans"').then((faces) => faces.length)`);
  assert.ok(faces >= 1, "CoFo Sans did not load");

  // The host-facing API exists.
  const keys = await page.eval(`Object.keys(window.CQA)`);
  for (const key of ["mount", "setClientApiContext", "version"]) assert.ok(keys.includes(key), `window.CQA.${key} is missing`);
}
