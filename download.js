import { parseMpd } from "./dash.js";
import { flatten, initTrack, initTracks, interleave, mergeInit, prepareFragment, trackDefaults } from "./fmp4.js";
import { isMaster, parseMaster, parseMedia, segmentIv } from "./hls.js";
import { toMp4 } from "./mux.js";
import { extensionOf, isWebUrl, safeFileName, send } from "./shared.js";

const CONCURRENCY = 6;
// ffmpeg.wasm holds input and output in a 32-bit heap (about 2-4 GB), so
// larger downloads are saved as raw tracks instead of converted.
const MAX_CONVERT_BYTES = 1.5 * 1024 ** 3;
const RETRIES = 3;

const params = new URLSearchParams(location.search);
const sourceUrl = params.get("url");
const title = params.get("title") || "video";
const $ = (id) => document.getElementById(id);
const status = (text, state = "") => {
  $("status").textContent = text;
  $("status").className = state;
};
const FORMAT_NAMES = { hls: "HLS stream", dash: "DASH stream", direct: "Video file" };

function setProgress(done, total, detail = "") {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  $("progress-card").hidden = false;
  $("progress").setAttribute("aria-valuenow", Math.round(pct));
  $("progress-fill").style.width = `${pct}%`;
  $("pct").textContent = `${Math.round(pct)}%`;
  $("detail").textContent = detail;
}

let savedId = null;
function markSaved(text, downloadId) {
  savedId = downloadId;
  document.querySelector(".headline").textContent = "Video saved";
  status(text, "done");
  $("show").hidden = downloadId == null;
}

async function fetchOk(url, as = "text") {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return as === "text" ? res.text() : res.arrayBuffer();
    } catch (error) {
      if (attempt >= RETRIES) throw error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

const keyCache = new Map();
function importKey(url) {
  if (!keyCache.has(url)) {
    keyCache.set(
      url,
      fetchOk(url, "buffer").then((raw) => crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])),
    );
  }
  return keyCache.get(url);
}

async function fetchSegment(segment) {
  const data = await fetchOk(segment.url, "buffer");
  if (!segment.key) return data;
  if (segment.key.method !== "AES-128") throw new Error(`Encryption ${segment.key.method} is not supported`);
  const key = await importKey(segment.key.url);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv: segmentIv(segment) }, key, data);
}

// TS -> fragmented MP4, one segment at a time (mux.js, H.264/AAC). It never
// holds the whole video, so it works at any size. Returns null for a segment
// it cannot convert (e.g. HEVC in TS).
function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function tsTransmuxer() {
  const transmuxer = new muxjs.mp4.Transmuxer();
  let init = null;
  let out = [];
  transmuxer.on("data", (segment) => {
    init ??= segment.initSegment;
    out.push(segment.data);
  });
  return (buffer) => {
    transmuxer.push(new Uint8Array(buffer));
    transmuxer.flush();
    if (!out.length) return null;
    const data = out.length === 1 ? out[0] : concat(out);
    out = [];
    return { init, data };
  };
}

const TRACK_IDS = { video: 1, audio: 2 };

// Downloads one track. Result: { init, fragments: [{ blob, time }], ext,
// fragmented }. Fragmented MP4 output (native fMP4, or TS converted on the
// fly with `transmux`) carries decode times so separate audio and video can
// be merged later; `role` rewrites track IDs for that merge.
async function fetchTrack({ init: initUrl, segments }, label, { transmux = false, role = null } = {}) {
  if (!segments.length) throw new Error("Playlist has no segments (live streams are not supported)");
  const raw = new Array(segments.length);
  const fragments = [];
  const convert = transmux ? tsTransmuxer() : null;
  const trackId = role ? TRACK_IDS[role] : null;
  let init = initUrl ? new Uint8Array(await fetchOk(initUrl, "buffer")) : null;
  let mode = convert ? "transmux" : "fmp4";
  let done = 0;
  let next = 0;
  let flushed = 0;

  let defaults = null;
  const add = (u8) => {
    if (mode !== "raw") {
      try {
        defaults ??= init ? trackDefaults(init) : new Map();
        const { parts, time, trafs } = prepareFragment(u8, trackId, defaults);
        fragments.push({ blob: new Blob(parts), time, trafs });
        return;
      } catch (error) {
        // Not fMP4 (e.g. a single progressive file): keep bytes as they are.
        if (fragments.length) throw error;
        mode = "raw";
      }
    }
    fragments.push({ blob: new Blob([u8]), time: 0 });
  };

  // Segments are handed over in playlist order; raw buffers are dropped once used.
  const drain = () => {
    while (flushed < segments.length && raw[flushed]) {
      const data = raw[flushed];
      raw[flushed++] = true;
      if (mode === "transmux") {
        const result = convert(data);
        if (result) {
          init = result.init;
          mode = "transmuxed";
          add(result.data);
          continue;
        }
        if (flushed > 1) throw new Error("Could not convert part of the stream to MP4");
        mode = "raw";
      } else if (mode === "transmuxed") {
        const result = convert(data);
        if (!result) throw new Error("Could not convert part of the stream to MP4");
        add(result.data);
        continue;
      }
      add(new Uint8Array(data));
    }
  };

  setProgress(0, segments.length);
  const worker = async () => {
    while (next < segments.length) {
      const i = next++;
      raw[i] = await fetchSegment(segments[i]);
      transfer.bytes += raw[i].byteLength;
      drain();
      const sizeSoFar = transfer.expected ? `${formatSize(transfer.bytes)} of ≈ ${formatSize(transfer.expected)}` : formatSize(transfer.bytes);
      setProgress(++done, segments.length, `${done} of ${segments.length} parts, ${sizeSoFar}`);
      status(`Downloading ${label}…`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const fragmented = mode !== "raw";
  return { init, fragments, fragmented, ext: fragmented || init ? "mp4" : "ts" };
}

const trackBlob = (track) => new Blob([...(track.init ? [track.init] : []), ...track.fragments.map((f) => f.blob)]);

async function hlsTrack(mediaUrl, label, role = null) {
  status(`Loading ${label} playlist…`);
  const { segments, map } = await loadMedia(mediaUrl);
  // fMP4 playlists carry an init segment; plain TS is converted on the fly.
  return fetchTrack({ init: map, segments }, label, { transmux: !map, role });
}

// Untyped blobs let Chrome guess from the name, and macOS maps .ts to a
// text type, so Chrome renames the file to .txt. Always set a video type.
const MIME_BY_EXT = {
  ts: "video/mp2t",
  mp4: "video/mp4",
  m4a: "audio/x-m4a",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  m4v: "video/mp4",
};

// Resolves when the user clicks the main button (a dialog needs a click).
function waitForClick(label) {
  return new Promise((resolve) => {
    $("start").textContent = label;
    $("start").hidden = false;
    $("start").onclick = () => {
      $("start").hidden = true;
      resolve();
    };
  });
}

async function saveWithPicker(blob, filename, type) {
  const name = filename.split("/").pop();
  const ext = `.${name.split(".").pop()}`;
  let label = `Save ${name} (${formatSize(blob.size)})`;
  status("Download finished. Choose where to save the video.");
  for (;;) {
    await waitForClick(label);
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Video", accept: { [type ?? "video/mp4"]: [ext] } }] });
      status(`Writing ${handle.name} to disk (${formatSize(blob.size)}). Keep this tab open…`);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return `${handle.name} (${formatSize(blob.size)})`;
    } catch (error) {
      if (error.name === "AbortError") status("Saving was canceled. The video is still in this tab, so you can save it now.");
      else status(`Couldn't write the file (${error.message}). The video is still in this tab, so you can try again.`, "error");
      label = "Try saving again";
    }
  }
}

// Starts a download with a link click and resolves with its download ID.
function downloadFromPage(url, filename) {
  return new Promise((resolve) => {
    const listener = (item) => {
      if (item.url !== url) return;
      chrome.downloads.onCreated.removeListener(listener);
      resolve(item.id);
    };
    chrome.downloads.onCreated.addListener(listener);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.split("/").pop();
    link.click();
  });
}

// Chrome copies the blob to disk after download() resolves; closing this
// tab (or reloading the extension) before that ends in "Network error".
// So wait for the copy to finish, and on failure let the user retry with
// the blob that is still here instead of downloading everything again.
async function saveBlob(blob, ext) {
  const filename = safeFileName(title, ext);
  const type = MIME_BY_EXT[ext.split(".").pop()];
  if (type && blob.type !== type) blob = new Blob([blob], { type });
  // Incognito: every Chrome download of this page's blobs fails, so the
  // file is written straight to disk through a save dialog instead.
  if (chrome.extension.inIncognitoContext && window.showSaveFilePicker) return saveWithPicker(blob, filename, type);
  const url = URL.createObjectURL(blob);
  let failed = false;
  try {
    for (;;) {
      status(`Writing ${filename} to disk (${formatSize(blob.size)}). Keep this tab open…`);
      // In incognito, chrome.downloads can't read this page's blob URLs
      // (every save fails with "Network error"), so the page starts the
      // download itself; that path is also the retry when the API fails.
      const viaPage = chrome.extension.inIncognitoContext || failed;
      savedId = viaPage ? await downloadFromPage(url, filename) : await chrome.downloads.download({ url, filename });
      if (await waitForDownload(savedId)) return `${filename} (${formatSize(blob.size)})`;
      failed = true;
      const [item] = await chrome.downloads.search({ id: savedId });
      status(`Couldn't write ${filename} to disk (${item?.error ?? "unknown error"}). The video is still in this tab, so you can try again.`, "error");
      await new Promise((resolve) => {
        $("start").textContent = "Try saving again";
        $("start").hidden = false;
        $("start").onclick = () => {
          $("start").hidden = true;
          resolve();
        };
      });
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Produce one MP4. Fragmented tracks are rewritten at the box level into a
// regular MP4 (index first, plays in QuickTime and seeks), merging separate
// audio in; this never needs the whole video in memory. If that fails, a
// fragmented MP4 is saved; other cases fall back to ffmpeg.wasm when small
// enough, otherwise the original tracks are saved.
async function finish(video, audio) {
  setProgress(1, 1, "All parts downloaded");
  const canMerge = audio && video.fragmented && audio.fragmented && video.init && audio.init;
  if ((!audio && video.fragmented && video.init) || canMerge) {
    status(audio ? "Merging audio and video into MP4…" : "Writing MP4…");
    let tracks, fragments, fallback;
    try {
      if (audio) {
        const v = initTrack(video.init, "vide");
        const a = initTrack(audio.init, "soun");
        tracks = [
          { ...v, id: 1 },
          { ...a, id: 2 },
        ];
        fragments = interleave(video.fragments, v.timescale, audio.fragments, a.timescale);
        fallback = () => [...mergeInit(v, a), ...fragments.map((f) => f.blob)];
      } else {
        tracks = initTracks(video.init);
        fragments = video.fragments;
        fallback = () => [trackBlob(video)];
      }
      let parts;
      try {
        parts = flatten(tracks, fragments, null);
      } catch (error) {
        console.warn("Could not write a regular MP4, saving fragmented MP4", error);
        parts = fallback();
      }
      markSaved(`Saved ${await saveBlob(new Blob(parts), "mp4")}.`, savedId);
      return;
    } catch (error) {
      console.warn("Box-level MP4 writing failed, trying ffmpeg", error);
    }
  }
  if (!audio && video.ext === "mp4") {
    markSaved(`Saved ${await saveBlob(trackBlob(video), "mp4")}.`, savedId);
    return;
  }
  const videoData = trackBlob(video);
  const audioData = audio ? trackBlob(audio) : null;
  status(audio ? "Merging audio and video into MP4…" : "Converting to MP4…");
  try {
    if (videoData.size + (audioData?.size ?? 0) > MAX_CONVERT_BYTES) throw new Error("video is too large to convert in the browser");
    const inputs = [{ data: videoData, ext: video.ext }];
    if (audio) inputs.push({ data: audioData, ext: audio.ext });
    const saved = await saveBlob(await toMp4(inputs), "mp4");
    markSaved(`Saved ${saved}.`, savedId);
  } catch (error) {
    const saved = [await saveBlob(videoData, video.ext)];
    // An MP4 audio-only track plays everywhere as .m4a.
    if (audio) saved.push(await saveBlob(audioData, audio.ext === "mp4" ? "audio.m4a" : `audio.${audio.ext}`));
    status(`Couldn't convert to MP4 (${error.message}). Saved the original tracks instead: ${saved.join(", ")}.`, "error");
    $("show").hidden = false;
  }
}

const keepOpen = (event) => {
  event.preventDefault();
  event.returnValue = "";
};

async function run(task) {
  window.addEventListener("beforeunload", keepOpen);
  $("start").hidden = true;
  for (const b of $("variants").querySelectorAll("button")) b.disabled = true;
  try {
    await task();
  } catch (error) {
    status(`Download stopped: ${error.message}`, "error");
  } finally {
    window.removeEventListener("beforeunload", keepOpen);
  }
}

// ---- Size estimates ----

const GB = 1024 ** 3;
const LARGE_BYTES = GB;

function formatSize(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  const mb = bytes / 1048576;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// Size of one URL from a 1-byte range request (exact total in Content-Range).
async function remoteSize(url) {
  try {
    const res = await fetch(url, { credentials: "include", headers: { Range: "bytes=0-0" } });
    res.body?.cancel();
    const total = res.headers.get("content-range")?.match(/\/(\d+)$/);
    if (total) return Number(total[1]);
    if (res.status === 200) return Number(res.headers.get("content-length")) || 0;
  } catch {}
  return 0;
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const EXACT_MAX_SEGMENTS = 40;
const SAMPLE_SEGMENTS = 8;

// Exact when the track is short enough to size every part; otherwise parts
// spread across the video are sized and scaled up by duration (or count).
// Returns { bytes, exact } or null when the server doesn't report sizes.
async function measureSegments(segments, initUrl = null) {
  if (!segments.length) return null;
  const exact = segments.length <= EXACT_MAX_SEGMENTS;
  const picks = exact ? segments : Array.from({ length: SAMPLE_SEGMENTS }, (_, i) => segments[Math.round((i * (segments.length - 1)) / (SAMPLE_SEGMENTS - 1))]);
  const sizes = await mapLimited(picks, 6, (seg) => remoteSize(seg.url));
  if (sizes.some((n) => !n)) return null;
  const sampled = sizes.reduce((n, x) => n + x, 0);
  let bytes = sampled;
  if (!exact) {
    const totalDuration = segments.reduce((n, seg) => n + (seg.duration ?? 0), 0);
    const pickedDuration = picks.reduce((n, seg) => n + (seg.duration ?? 0), 0);
    bytes = totalDuration && pickedDuration ? (sampled * totalDuration) / pickedDuration : (sampled / picks.length) * segments.length;
  }
  if (initUrl) bytes += (await remoteSize(initUrl)) || 0;
  return { bytes, exact };
}

// Bitrate x duration, used when part sizes can't be measured.
const fromBitrate = (bitsPerSecond, seconds) => (bitsPerSecond && seconds ? { bytes: (bitsPerSecond * seconds) / 8, exact: false } : null);

function addEstimates(a, b) {
  if (!a || !b) return a ?? b ?? null;
  return { bytes: a.bytes + b.bytes, exact: a.exact && b.exact };
}

const sizeText = (estimate) => (estimate ? `${estimate.exact ? "" : "≈ "}${formatSize(estimate.bytes)}` : "");

// Bytes downloaded so far and the expected total, for the progress detail.
const transfer = { bytes: 0, expected: null };

// ---- Quality choices ----

// Quality segment: the first (best) choice is preselected; the primary
// button names exactly what will be saved, with its size once estimated.
// Videos of 1 GB or more are called out before the download starts.
function showChoices(choices) {
  status("Pick a quality, then save.");
  let selected = null;
  const render = () => {
    const { choice } = selected;
    const size = sizeText(choice.estimate);
    $("start").textContent = size ? `Save ${choice.label} as MP4 (${size})` : `Save ${choice.label} as MP4`;
    const large = choice.estimate && choice.estimate.bytes >= LARGE_BYTES;
    $("size-note").hidden = !large;
    if (large) {
      $("size-note").textContent =
        `Large video: ${choice.estimate.exact ? "" : "about "}${formatSize(choice.estimate.bytes)}. Keep this tab open until it's saved, and make sure you have at least that much free disk space.`;
    }
  };
  const select = (choice, button) => {
    for (const b of $("variants").children) b.setAttribute("aria-pressed", String(b === button));
    selected = { choice, button };
    $("start").onclick = () => {
      transfer.expected = choice.estimate?.bytes ?? null;
      run(choice.start);
    };
    render();
  };
  choices.forEach((choice, i) => {
    const button = document.createElement("button");
    button.innerHTML = `<span class="label"></span><span class="rate"></span>`;
    button.querySelector(".label").textContent = choice.label;
    button.querySelector(".rate").textContent = "Measuring…";
    button.onclick = () => select(choice, button);
    $("variants").append(button);
    if (i === 0) select(choice, button);
    choice.measure().then((estimate) => {
      choice.estimate = estimate;
      button.querySelector(".rate").textContent = sizeText(estimate) || choice.rate;
      button.classList.toggle("large", Boolean(estimate && estimate.bytes >= LARGE_BYTES));
      if (selected?.choice === choice) render();
    });
  });
  $("start").hidden = false;
}

const quality = (height, bandwidth) => ({
  label: height ? `${height}p` : "Original quality",
  rate: bandwidth ? `${(bandwidth / 1e6).toFixed(1)} Mbps` : "",
});

// Playlists are fetched once: for size estimates, then for the download.
const playlists = new Map();
function loadMedia(url) {
  if (!playlists.has(url))
    playlists.set(
      url,
      fetchOk(url).then((text) => parseMedia(text, url)),
    );
  return playlists.get(url);
}

async function measureHls(url, bitrate) {
  const { segments, map } = await loadMedia(url);
  const seconds = segments.reduce((n, seg) => n + seg.duration, 0);
  return (await measureSegments(segments, map)) ?? fromBitrate(bitrate, seconds);
}

async function startHls() {
  const text = await fetchOk(sourceUrl);
  if (!isMaster(text)) {
    // A single media playlist: one choice, so the size shows before saving.
    const height = sourceUrl.match(/(\d{3,4})p/)?.[1];
    return showChoices([
      {
        ...quality(Number(height) || 0, 0),
        measure: () => measureHls(sourceUrl, 0).catch(() => null),
        start: async () => finish(await hlsTrack(sourceUrl, "video")),
      },
    ]);
  }
  const audioSizes = new Map();
  showChoices(
    parseMaster(text, sourceUrl).map((v) => ({
      ...quality(v.height, v.bandwidth),
      measure: async () => {
        const video = await measureHls(v.url, v.averageBandwidth || v.bandwidth).catch(() => null);
        if (!v.audioUrl) return video;
        if (!audioSizes.has(v.audioUrl))
          audioSizes.set(
            v.audioUrl,
            measureHls(v.audioUrl, 0).catch(() => null),
          );
        return addEstimates(video, await audioSizes.get(v.audioUrl));
      },
      start: async () => {
        const role = v.audioUrl ? "video" : null;
        const videoTrack = await hlsTrack(v.url, "video", role);
        return finish(videoTrack, v.audioUrl ? await hlsTrack(v.audioUrl, "audio", "audio") : null);
      },
    })),
  );
}

async function startDash() {
  const { video, audio, seconds } = parseMpd(await fetchOk(sourceUrl), sourceUrl);
  if (!video.length) throw new Error("No video track in DASH manifest");
  const bestAudio = audio[0];
  const measureRep = async (rep) => (await measureSegments(rep.segments, rep.init)) ?? fromBitrate(rep.bandwidth, seconds);
  const audioSize = bestAudio ? measureRep(bestAudio).catch(() => null) : Promise.resolve(null);
  showChoices(
    video.map((v) => ({
      ...quality(v.height, v.bandwidth),
      measure: async () => addEstimates(await measureRep(v).catch(() => null), await audioSize),
      start: async () => {
        const videoTrack = await fetchTrack(v, "video", { role: bestAudio ? "video" : null });
        return finish(videoTrack, bestAudio ? await fetchTrack(bestAudio, "audio", { role: "audio" }) : null);
      },
    })),
  );
}

// Resolves true when a Chrome download finishes, false if it fails.
function waitForDownload(id) {
  return new Promise((resolve) => {
    const settle = (state) => {
      if (state === "in_progress") return;
      chrome.downloads.onChanged.removeListener(listener);
      resolve(state === "complete");
    };
    const listener = (delta) => {
      if (delta.id === id && delta.state) settle(delta.state.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    // It may already have finished before the listener was added.
    chrome.downloads.search({ id }).then(([item]) => item && settle(item.state));
  });
}

async function startDirect() {
  const filename = safeFileName(title, extensionOf(sourceUrl));
  const size = await remoteSize(sourceUrl);
  if (size >= LARGE_BYTES) {
    $("size-note").hidden = false;
    $("size-note").textContent = `Large video: ${formatSize(size)}. Make sure you have at least that much free disk space.`;
  }
  const id = await send("downloadNative", { url: sourceUrl, filename });
  if (id != null) {
    setProgress(1, 1, "Handed to Chrome");
    status(`Saving ${filename} with Chrome's downloader. Progress shows in Chrome's downloads.`);
    if (await waitForDownload(id)) {
      markSaved(`Saved ${filename}.`, id);
      return;
    }
    status("Chrome's downloader was refused. Retrying with the page's Referer…");
  }
  return startBufferedDirect();
}

// Fallback for servers that need the page Referer: the whole file is
// fetched into memory, so very large files may fail here.
async function startBufferedDirect() {
  const res = await fetch(sourceUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${sourceUrl}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  setProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const mb = `${(received / 1048576).toFixed(1)} MB`;
    setProgress(received, total, total ? `${mb} of ${(total / 1048576).toFixed(1)} MB` : mb);
    status("Downloading video…");
  }
  const blob = new Blob(chunks, { type: res.headers.get("content-type") ?? "video/mp4" });
  const saved = await saveBlob(blob, extensionOf(sourceUrl));
  markSaved(`Saved ${saved}.`, savedId);
}

const kind = params.get("kind");
if (!isWebUrl(sourceUrl)) {
  status("Only http and https video links can be downloaded.", "error");
  throw new Error(`Refusing non-web URL: ${sourceUrl}`);
}
$("title").textContent = title;
document.title = `Saving ${title}`;
$("format").textContent = (FORMAT_NAMES[kind] ?? "video").toLowerCase().replace("hls", "HLS").replace("dash", "DASH");
$("host").textContent = new URL(sourceUrl).hostname;
$("show").onclick = () => savedId != null && chrome.downloads.show(savedId);
$("close").onclick = () => window.close();
run(async () => {
  await send("useReferer", { referer: params.get("referer") });
  await (kind === "direct" ? startDirect() : kind === "dash" ? startDash() : startHls());
});
