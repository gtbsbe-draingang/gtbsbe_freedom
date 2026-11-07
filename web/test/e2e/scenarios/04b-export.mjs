import assert from "node:assert/strict";

export const name = "export";
export const path = "/";
export const viewports = [[1400, 900], [600, 800]];

export async function run(page) {
  await page.waitFor('[data-test="queue-item"]', 10000);
  if (page.viewport[0] < 900) await page.click('[data-test="queue-toggle"]');
  await page.waitFor('[data-test="queue-export"]');

  // Inspect the actual download link without letting Chrome save test files.
  await page.eval(`window.__exportBlobs = new Map();
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = createObjectURL(blob);
    window.__exportBlobs.set(url, blob);
    return url;
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[download]");
    if (!link) return;
    event.preventDefault();
    window.__download = { href: link.href, filename: link.download };
  })`);

  async function download(filename) {
    await page.click('[data-test="queue-export"]');
    const result = await page.eval(`(async () => {
      const download = window.__download;
      return { ...download, text: await window.__exportBlobs.get(download.href).text() };
    })()`);
    assert.equal(result.filename, filename);
    assert.ok(result.text.includes("Диалог"));
    assert.ok(result.text.includes("DEV"));
    assert.equal(await page.eval("location.hash"), "", "export does not navigate away");
    return result;
  }

  const first = await download("cqa-all.csv");
  const second = await download("cqa-all.csv");
  assert.notEqual(first.href, second.href, "each click gets a fresh export");

  await page.eval(`window.__cqaTest.api.importDataset("CTRL")`);
  await page.eval(`window.__cqaTest.store.set((s) => ({ queueRefresh: s.queueRefresh + 1 }))`);
  const deadline = Date.now() + 4000;
  while (!(await page.eval(`!!document.querySelector('[data-test="queue-group-filter"] option[value="CTRL"]')`))) {
    if (Date.now() > deadline) throw new Error("CTRL group did not load");
    await page.sleep(25);
  }
  await page.eval(`window.__cqaTest.store.set({ queueGroup: "DEV" })`);
  const selected = await download("cqa-DEV.csv");
  assert.ok(!selected.text.includes("CTRL"), "only the selected dataset is exported");
  await page.eval(`window.__cqaTest.store.set({ queueGroup: "" })`);
  const all = await download("cqa-all.csv");
  assert.ok(all.text.includes("CTRL"), "all datasets are exported when no group is selected");
}
