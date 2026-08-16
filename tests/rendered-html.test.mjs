import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Common Days prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Common Days/i);
  assert.match(html, /When is everyone free/);
  assert.match(html, /Upload once/);
  assert.match(html, /Everyone reuses it/);
  assert.match(html, /Upload multiple screenshots or one PDF/);
  assert.match(html, /academic calendar for 20XX-XY for XYZ school/);
  assert.match(html, /AI parses the images/);
  assert.match(html, /That year becomes reusable/);
  assert.match(html, /UIUC/);
  assert.match(html, /SAMPLE DATA/);
  assert.match(html, /December 2026/);
  assert.match(html, /Month calendar/);
  assert.match(html, /EVERYONE IS OFF/);
  assert.match(html, /Report a calendar issue/);
  assert.doesNotMatch(html, /maximum reached/i);
  assert.doesNotMatch(html, /Your group.s calendar/i);
  assert.doesNotMatch(html, /class="site-header"/);
  assert.doesNotMatch(html, /class="hero"/);
  assert.doesNotMatch(html, /class="how-section"/);
  assert.doesNotMatch(html, /<footer>/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("ships product metadata and interactive source", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /What school are we adding/);
  assert.match(page, /Submit for review/);
  assert.match(page, /getCommonBreaks/);
  assert.match(page, /function MonthDay/);
  assert.match(page, /No school-wide break reported/);
  assert.match(page, /Correction request ready/);
  assert.match(page, /Nothing was sent or changed/);
  assert.match(page, /submitReport/);
  assert.match(page, /MAX_SCREENSHOTS = 10/);
  assert.match(page, /type="file"/);
  assert.match(page, /multiple/);
  assert.match(page, /application\/pdf/);
  assert.match(page, /10 screenshots added—maximum reached/);
  assert.match(layout, /og\.png/);
  assert.match(layout, /Common Days/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
