import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { flatten, initTrack, initTracks, interleave, mergeInit, prepareFragment, trackDefaults } from "../fmp4.js";

// Fixtures come from scripts/make-fixtures.sh: 2 s of 64x64 H.264 at
// 10 fps and 2 s of 48 kHz AAC, each as a separate fMP4 track.
const fixture = (name) => new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));
const segments = (kind) => [0, 1, 2].map((i) => `${kind}-${i}.m4s`).filter((n) => kind !== "video" || n !== "video-2.m4s");

function loadTrack(kind, role) {
  const init = fixture(`${kind}-init.mp4`);
  const defaults = trackDefaults(init);
  const fragments = segments(kind).map((name) => {
    const { parts, time, trafs } = prepareFragment(fixture(name), role, defaults);
    return { blob: new Blob(parts), time, trafs };
  });
  return { init, fragments };
}

// Top-level box types, and the track count inside moov.
function topBoxes(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (let o = 0; o + 8 <= u8.length; ) {
    let size = dv.getUint32(o);
    if (size === 1) size = Number(dv.getBigUint64(o + 8));
    out.push(String.fromCharCode(...u8.subarray(o + 4, o + 8)));
    o += size;
  }
  return out;
}
const count = (u8, type) => Buffer.from(u8).toString("latin1").split(type).length - 1;

const hasFfprobe = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function probe(bytes) {
  const file = join(mkdtempSync(join(tmpdir(), "udl-")), "out.mp4");
  writeFileSync(file, bytes);
  const json = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(json);
}

test("initTrack finds the track of each handler", () => {
  const video = initTrack(fixture("video-init.mp4"), "vide");
  const audio = initTrack(fixture("audio-init.mp4"), "soun");
  assert.ok(video.timescale > 0);
  assert.equal(audio.timescale, 48000);
  assert.throws(() => initTrack(fixture("video-init.mp4"), "soun"), /no soun track/);
});

test("prepareFragment keeps moof/mdat, rewrites the track ID, and reads decode time", () => {
  const defaults = trackDefaults(fixture("video-init.mp4"));
  const first = prepareFragment(fixture("video-0.m4s"), 7, defaults);
  const second = prepareFragment(fixture("video-1.m4s"), 7, defaults);
  assert.deepEqual(topBoxes(new Uint8Array(Buffer.concat(first.parts))), ["moof", "mdat"]);
  assert.equal(first.time, 0);
  assert.ok(second.time > 0);
  assert.ok(first.trafs.every((t) => t.id === 7));
});

test("prepareFragment rejects a progressive MP4", () => {
  assert.throws(() => prepareFragment(fixture("video-init.mp4")), /no MP4 fragments/);
});

test("interleave orders fragments by decode time across timescales", () => {
  const v = [{ time: 0 }, { time: 10 }, { time: 20 }];
  const a = [{ time: 0 }, { time: 48000 }, { time: 96000 }];
  const order = interleave(v, 10, a, 48000).map((f) => (v.includes(f) ? `v${f.time}` : `a${f.time}`));
  assert.deepEqual(order, ["a0", "v0", "a48000", "v10", "a96000", "v20"]);
});

test("mergeInit builds one moov with video as track 1 and audio as track 2", async () => {
  const v = initTrack(fixture("video-init.mp4"), "vide");
  const a = initTrack(fixture("audio-init.mp4"), "soun");
  const merged = new Uint8Array(await new Blob(mergeInit(v, a)).arrayBuffer());
  assert.deepEqual(topBoxes(merged), ["ftyp", "moov"]);
  assert.equal(count(merged, "trak"), 2);
  assert.equal(count(merged, "trex"), 2);
});

test("flatten writes a regular MP4 with both tracks", async () => {
  const video = loadTrack("video", 1);
  const audio = loadTrack("audio", 2);
  const v = initTrack(video.init, "vide");
  const a = initTrack(audio.init, "soun");
  const tracks = [
    { ...v, id: 1 },
    { ...a, id: 2 },
  ];
  const fragments = interleave(video.fragments, v.timescale, audio.fragments, a.timescale);
  const bytes = new Uint8Array(await new Blob(flatten(tracks, fragments)).arrayBuffer());
  assert.deepEqual(topBoxes(bytes), ["ftyp", "moov", "mdat"]);
  assert.equal(count(bytes, "moof"), 0);

  if (!hasFfprobe) return;
  const info = probe(bytes);
  assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  assert.equal(info.streams.find((s) => s.codec_type === "video").nb_frames, "20");
  // The source video starts at 0.2 s (B-frame composition offset), so
  // compare against the unmerged tracks rather than a fixed 2 s.
  const source = (kind) => {
    const track = loadTrack(kind, null);
    return Number(probe(Buffer.concat([track.init, ...segments(kind).map(fixture)])).format.duration);
  };
  const expected = Math.max(source("video"), source("audio"));
  assert.ok(Math.abs(Number(info.format.duration) - expected) < 0.05, `duration ${info.format.duration}, expected ${expected}`);
});

test("flatten keeps a single-track init's own track IDs", async () => {
  const video = loadTrack("video", null);
  const bytes = new Uint8Array(await new Blob(flatten(initTracks(video.init), video.fragments)).arrayBuffer());
  assert.deepEqual(topBoxes(bytes), ["ftyp", "moov", "mdat"]);
  assert.throws(() => flatten([], video.fragments), /unknown track/);
});
