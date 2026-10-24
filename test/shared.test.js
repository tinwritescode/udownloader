import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionOf, formatBytes, isWebUrl, safeFileName } from "../shared.js";

test("safeFileName strips characters that are invalid in file names", () => {
  assert.equal(safeFileName('My: "Video" / part\u00071?', "mp4"), "My Video part 1.mp4");
  assert.equal(safeFileName("", "ts"), "video.ts");
  assert.equal(safeFileName("///", "mp4"), "video.mp4");
  assert.equal(safeFileName("a".repeat(300), "mp4").length, 124);
});

test("formatBytes picks a unit", () => {
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.00 GB");
});

test("extensionOf reads the path extension, ignoring the query", () => {
  assert.equal(extensionOf("https://x.example/a/b.WEBM?token=1.mp4"), "webm");
  assert.equal(extensionOf("https://x.example/stream"), "mp4");
  assert.equal(extensionOf("https://x.example/stream", "ts"), "ts");
});

test("isWebUrl accepts only http and https", () => {
  assert.equal(isWebUrl("https://x.example/v.mp4"), true);
  assert.equal(isWebUrl("http://x.example/v.mp4"), true);
  for (const url of ["file:///etc/passwd", "chrome://settings", "data:video/mp4;base64,AA", "javascript:alert(1)", "", null, "not a url"]) {
    assert.equal(isWebUrl(url), false, String(url));
  }
});
