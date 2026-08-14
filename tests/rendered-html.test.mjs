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
  assert.match(html, /Find the break/);
  assert.match(html, /UIUC/);
  assert.match(html, /SAMPLE DATA/);
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
  assert.match(layout, /og\.png/);
  assert.match(layout, /Common Days/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
