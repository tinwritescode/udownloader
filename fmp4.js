// Box-level fragmented MP4 helpers. They merge a video-only and an audio-only
// fMP4 track into one file without decoding or holding the whole video:
// the two init segments become one moov with two tracks, and fragments are
// interleaved by decode time. Track IDs are rewritten to 1 (video) and
// 2 (audio) as fragments arrive.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "edts", "dinf"]);
const typeAt = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

function* boxes(u8, start = 0, end = u8.length) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = view.getUint32(o);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) throw new Error(`Malformed MP4 box at ${o}`);
    yield { type: typeAt(u8, o + 4), start: o, end: o + size, body: o + header };
    o += size;
  }
}

function find(u8, path, start = 0, end = u8.length) {
  const [head, ...rest] = path;
  for (const box of boxes(u8, start, end)) {
    if (box.type !== head) continue;
    if (!rest.length) return box;
    const found = find(u8, rest, box.body, box.end);
    if (found) return found;
  }
  return null;
}

function findAll(u8, type, start = 0, end = u8.length, out = []) {
  for (const box of boxes(u8, start, end)) {
    if (box.type === type) out.push(box);
    else if (CONTAINERS.has(box.type)) findAll(u8, type, box.body, box.end, out);
  }
  return out;
}

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
// Full boxes: version byte first; track_ID offsets differ by version.
const version = (u8, box) => u8[box.body];

function setU32(u8, offset, value) {
  view(u8).setUint32(offset, value);
}

function box(type, payloads) {
  const size = 8 + payloads.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  let o = 8;
  for (const p of payloads) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const slice = (u8, b) => u8.slice(b.start, b.end);

function handlerOf(u8, trak) {
  const hdlr = find(u8, ["mdia", "hdlr"], trak.body, trak.end);
  return hdlr ? typeAt(u8, hdlr.body + 8) : "";
}

function timescaleOf(u8, trak) {
  const mdhd = find(u8, ["mdia", "mdhd"], trak.body, trak.end);
  return view(u8).getUint32(mdhd.body + (version(u8, mdhd) === 1 ? 20 : 12));
}

// The first track of the given handler ("vide"/"soun") in an init segment.
export function initTrack(init, handler) {
  const moov = find(init, ["moov"]);
  if (!moov) throw new Error("Init segment has no moov");
  const trak = findAll(init, "trak", moov.body, moov.end).find((t) => handlerOf(init, t) === handler);
  if (!trak) throw new Error(`Init segment has no ${handler} track`);
  const tkhd = find(init, ["tkhd"], trak.body, trak.end);
  const trackId = view(init).getUint32(tkhd.body + (version(init, tkhd) === 1 ? 20 : 12));
  const trex = findAll(init, "trex", moov.body, moov.end).find((t) => view(init).getUint32(t.body + 4) === trackId);
  if (!trex) throw new Error("Init segment has no trex for its track");
  return { init, moov, trak, trex, timescale: timescaleOf(init, trak) };
}

// Every track of an init segment, keyed by its own track ID.
export function initTracks(init) {
  const moov = find(init, ["moov"]);
  if (!moov) throw new Error("Init segment has no moov");
  return findAll(init, "trak", moov.body, moov.end).map((trak) => {
    const tkhd = find(init, ["tkhd"], trak.body, trak.end);
    const id = view(init).getUint32(tkhd.body + (version(init, tkhd) === 1 ? 20 : 12));
    return { init, moov, trak, id, timescale: timescaleOf(init, trak) };
  });
}

function withTrackId(track, id) {
  const trak = slice(track.init, track.trak);
  const tkhd = find(trak, ["trak", "tkhd"]);
  setU32(trak, tkhd.body + (version(trak, tkhd) === 1 ? 20 : 12), id);
  const trex = slice(track.init, track.trex);
  setU32(trex, 12, id);
  return { trak, trex };
}

export function mergeInit(video, audio) {
  const { init } = video;
  const ftyp = find(init, ["ftyp"]);
  const mvhd = slice(init, find(init, ["mvhd"], video.moov.body, video.moov.end));
  setU32(mvhd, mvhd.length - 4, 3); // next_track_ID
  const v = withTrackId(video, 1);
  const a = withTrackId(audio, 2);
  const moov = box("moov", [mvhd, v.trak, a.trak, box("mvex", [v.trex, a.trex])]);
  return ftyp ? [slice(init, ftyp), moov] : [moov];
}

const u24 = (u8, o) => (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2];

// trex defaults per track ID, used when tfhd/trun leave fields out.
export function trackDefaults(init) {
  const defaults = new Map();
  for (const trex of findAll(init, "trex")) {
    const dv = view(init);
    const o = trex.body + 4;
    defaults.set(dv.getUint32(o), { duration: dv.getUint32(o + 8), size: dv.getUint32(o + 12), flags: dv.getUint32(o + 16) });
  }
  return defaults;
}

// Sample tables of one traf: data byte ranges (in segment coordinates) and
// per-sample duration, size, sync flag and composition offset.
function parseTraf(u8, traf, moofStart, defaults) {
  const dv = view(u8);
  const tfhd = find(u8, ["tfhd"], traf.body, traf.end);
  const tf = u24(u8, tfhd.body + 1);
  const id = dv.getUint32(tfhd.body + 4);
  const d = { ...(defaults.get(id) ?? { duration: 0, size: 0, flags: 0 }) };
  let p = tfhd.body + 8;
  let base = moofStart;
  if (tf & 0x01) {
    base = Number(dv.getBigUint64(p));
    p += 8;
  }
  if (tf & 0x02) p += 4;
  if (tf & 0x08) (d.duration = dv.getUint32(p)), (p += 4);
  if (tf & 0x10) (d.size = dv.getUint32(p)), (p += 4);
  if (tf & 0x20) d.flags = dv.getUint32(p);
  const runs = [];
  let cursor = base;
  for (const trun of findAll(u8, "trun", traf.body, traf.end)) {
    const rf = u24(u8, trun.body + 1);
    const signed = version(u8, trun) === 1;
    const count = dv.getUint32(trun.body + 4);
    let q = trun.body + 8;
    let start = cursor;
    if (rf & 0x01) (start = base + dv.getInt32(q)), (q += 4);
    let firstFlags = null;
    if (rf & 0x04) (firstFlags = dv.getUint32(q)), (q += 4);
    const run = { start, end: start, durations: [], sizes: [], sync: [], cto: [] };
    for (let i = 0; i < count; i++) {
      let duration = d.duration;
      let size = d.size;
      let flags = i === 0 && firstFlags != null ? firstFlags : d.flags;
      let cto = 0;
      if (rf & 0x100) (duration = dv.getUint32(q)), (q += 4);
      if (rf & 0x200) (size = dv.getUint32(q)), (q += 4);
      if (rf & 0x400) {
        const f = dv.getUint32(q);
        q += 4;
        if (!(i === 0 && firstFlags != null)) flags = f;
      }
      if (rf & 0x800) (cto = signed ? dv.getInt32(q) : dv.getUint32(q)), (q += 4);
      // A zero duration would repeat a timestamp; players reject that.
      run.durations.push(duration || 1);
      run.sizes.push(size);
      run.sync.push(((flags >> 16) & 1) === 0);
      run.cto.push(cto);
      run.end += size;
    }
    cursor = run.end;
    runs.push(run);
  }
  return { id, runs };
}

// Keeps only moof/mdat pairs of one media segment (drops styp, sidx, emsg),
// optionally rewriting every tfhd to `trackId`. Returns the fragment bytes,
// its first decode time in track timescale units, and its sample tables
// (`trafs`, with data ranges as offsets into the returned bytes) so the
// file can later be written as a regular, non-fragmented MP4.
export function prepareFragment(u8, trackId = null, defaults = new Map()) {
  const kept = [];
  let time = null;
  const trafs = [];
  for (const b of boxes(u8)) {
    if (b.type !== "moof" && b.type !== "mdat") continue;
    kept.push(b);
    if (b.type !== "moof") continue;
    for (const traf of findAll(u8, "traf", b.body, b.end)) {
      const parsed = parseTraf(u8, traf, b.start, defaults);
      if (trackId != null) parsed.id = trackId;
      trafs.push(parsed);
      const tfdt = find(u8, ["tfdt"], traf.body, traf.end);
      if (tfdt && time == null) {
        time = version(u8, tfdt) === 1 ? Number(view(u8).getBigUint64(tfdt.body + 4)) : view(u8).getUint32(tfdt.body + 4);
      }
    }
  }
  // A progressive MP4 (moov + mdat, no moof) is not a fragment.
  if (!kept.some((b) => b.type === "moof")) throw new Error("Segment has no MP4 fragments");

  // Map segment offsets to offsets in the concatenated kept boxes.
  let pos = 0;
  const spans = kept.map((b) => {
    const span = { from: b.start, to: b.end, at: pos };
    pos += b.end - b.start;
    return span;
  });
  const remap = (offset) => {
    const span = spans.find((sp) => offset >= sp.from && offset <= sp.to);
    if (!span) throw new Error("Sample data lies outside the fragment");
    return span.at + offset - span.from;
  };
  for (const traf of trafs) {
    for (const run of traf.runs) {
      run.start = remap(run.start);
      run.end = remap(run.end);
    }
  }

  const parts = kept.map((b) => {
    const part = slice(u8, b);
    if (b.type === "moof" && trackId != null) for (const tfhd of findAll(part, "tfhd")) setU32(part, tfhd.body + 4, trackId);
    return part;
  });
  return { parts, time: time ?? 0, trafs };
}

// Interleave two fragment lists ({ blob, time, ... } in their own
// timescales) by decode time, so players read audio and video together.
export function interleave(videoFragments, videoScale, audioFragments, audioScale) {
  const out = [];
  let a = 0;
  for (const vf of videoFragments) {
    while (a < audioFragments.length && audioFragments[a].time / audioScale <= vf.time / videoScale) out.push(audioFragments[a++]);
    out.push(vf);
  }
  while (a < audioFragments.length) out.push(audioFragments[a++]);
  return out;
}

// ---- Writing a regular (non-fragmented) MP4 ----

function fullBox(type, version, flags, payloads) {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 0xff;
  head[2] = (flags >> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, [head, ...payloads]);
}

function u32s(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = view(out);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
  return out;
}

// Run-length pairs [count, value] of consecutive equal values.
function runLengths(values) {
  const pairs = [];
  for (const v of values) {
    const last = pairs[pairs.length - 1];
    if (last && last[1] === v) last[0]++;
    else pairs.push([1, v]);
  }
  return pairs;
}

function sampleTable(stsd, t) {
  const stts = runLengths(t.durations);
  const children = [stsd, fullBox("stts", 0, 0, [u32s([stts.length, ...stts.flat()])])];
  if (t.cto.some((c) => c !== 0)) {
    const ctts = runLengths(t.cto);
    children.push(fullBox("ctts", 1, 0, [u32s([ctts.length, ...ctts.flat()])]));
  }
  if (t.sync.some((s) => !s)) {
    const sync = [];
    t.sync.forEach((s, i) => s && sync.push(i + 1));
    children.push(fullBox("stss", 0, 0, [u32s([sync.length, ...sync])]));
  }
  const stsc = [];
  t.chunks.forEach((c, i) => {
    if (!stsc.length || stsc[stsc.length - 1][1] !== c.samples) stsc.push([i + 1, c.samples, 1]);
  });
  children.push(fullBox("stsc", 0, 0, [u32s([stsc.length, ...stsc.flat()])]));
  children.push(fullBox("stsz", 0, 0, [u32s([0, t.sizes.length, ...t.sizes])]));
  const co64 = new Uint8Array(4 + t.chunks.length * 8);
  view(co64).setUint32(0, t.chunks.length);
  t.chunks.forEach((c, i) => view(co64).setBigUint64(4 + i * 8, BigInt(c.offset)));
  children.push(fullBox("co64", 0, 0, [co64]));
  return box("stbl", children);
}

function rewrite(u8, start, end, fn) {
  const out = [];
  for (const b of boxes(u8, start, end)) {
    const replaced = fn(b);
    if (replaced === null) continue;
    if (replaced) out.push(replaced);
    else if (CONTAINERS.has(b.type)) out.push(box(b.type, rewrite(u8, b.body, b.end, fn)));
    else out.push(slice(u8, b));
  }
  return out;
}

// Duration field offsets from the box body start, for version 0 and 1.
function setDuration(u8, b, [v0, v1], value) {
  const copy = slice(u8, b);
  const at = b.body - b.start + (version(u8, b) === 1 ? v1 : v0);
  if (version(u8, b) === 1) view(copy).setBigUint64(at, BigInt(value));
  else view(copy).setUint32(at, Math.min(value, 0xffffffff));
  return copy;
}

const newTable = () => ({ durations: [], sizes: [], sync: [], cto: [], chunks: [] });

// Adds a fragment's sample runs to per-track tables. `onRun(run, chunk)`
// receives each non-empty run and the chunk record whose `offset` the
// caller sets to where that run's bytes land in the output file.
function addSamples(tables, trafs, onRun) {
  for (const traf of trafs) {
    if (!tables.has(traf.id)) tables.set(traf.id, newTable());
    const table = tables.get(traf.id);
    for (const run of traf.runs) {
      if (!run.sizes.length) continue;
      table.durations.push(...run.durations);
      table.sizes.push(...run.sizes);
      table.sync.push(...run.sync);
      table.cto.push(...run.cto);
      const chunk = { samples: run.sizes.length, offset: 0 };
      table.chunks.push(chunk);
      onRun(run, chunk);
    }
  }
}

// A moov with full sample tables for `tracks` ([{ init, trak, id,
// timescale }] from initTrack/initTracks; `id` = the ID fragments carry).
function buildMoov(tracks, tables) {
  const { init } = tracks[0];
  const moovBox = find(init, ["moov"]);
  const mvhdBox = find(init, ["mvhd"], moovBox.body, moovBox.end);
  const movieScale = view(init).getUint32(mvhdBox.body + (version(init, mvhdBox) === 1 ? 20 : 12));
  let movieDuration = 0;
  const traks = tracks.map((t) => {
    const table = tables.get(t.id) ?? newTable();
    const total = table.durations.reduce((n, d) => n + d, 0);
    const inMovie = Math.round((total / t.timescale) * movieScale);
    movieDuration = Math.max(movieDuration, inMovie);
    const stbl = find(t.init, ["mdia", "minf", "stbl"], t.trak.body, t.trak.end);
    const stsd = slice(t.init, find(t.init, ["stsd"], stbl.body, stbl.end));
    return box(
      "trak",
      rewrite(t.init, t.trak.body, t.trak.end, (b) => {
        if (b.type === "edts") return null;
        if (b.type === "stbl") return sampleTable(stsd, table);
        if (b.type === "tkhd") {
          const copy = setDuration(t.init, b, [20, 28], inMovie);
          view(copy).setUint32(b.body - b.start + (version(t.init, b) === 1 ? 20 : 12), t.id);
          return copy;
        }
        if (b.type === "mdhd") return setDuration(t.init, b, [16, 24], total);
        return undefined;
      }),
    );
  });
  const mvhd = setDuration(init, mvhdBox, [16, 24], movieDuration);
  setU32(mvhd, mvhd.length - 4, Math.max(...tracks.map((t) => t.id)) + 1);
  return box("moov", [mvhd, ...traks]);
}

const FTYP = box("ftyp", [new TextEncoder().encode("isom"), u32s([512]), new TextEncoder().encode("isomiso2avc1mp41")]);

function mdatHeader(dataBytes) {
  const header = new Uint8Array(16);
  view(header).setUint32(0, 1); // size 1: 64-bit size follows
  header.set([109, 100, 97, 116], 4); // "mdat"
  view(header).setBigUint64(8, BigInt(16 + dataBytes));
  return header;
}

// Writes ftyp + moov (full sample tables, first so playback starts at once)
// + one mdat holding every sample run in the given (interleaved) order.
// Returns Blob parts.
export function flatten(tracks, fragments) {
  const tables = new Map();
  const runs = [];
  for (const fragment of fragments) {
    addSamples(tables, fragment.trafs, (run, chunk) => runs.push({ blob: fragment.blob, start: run.start, end: run.end, chunk }));
  }
  for (const id of tables.keys()) if (!tracks.some((t) => t.id === id)) throw new Error(`Fragment references unknown track ${id}`);
  // Offsets depend on the moov size, which doesn't depend on the offsets.
  const offset = FTYP.length + buildMoov(tracks, tables).length + 16;
  let dataBytes = 0;
  for (const run of runs) {
    run.chunk.offset = offset + dataBytes;
    dataBytes += run.end - run.start;
  }
  return [FTYP, buildMoov(tracks, tables), mdatHeader(dataBytes), ...runs.map((r) => r.blob.slice(r.start, r.end))];
}

// Writes a regular MP4 straight to a file as fragments arrive: ftyp, then
// one mdat with sample data, then the moov at the end (its size isn't known
// earlier). Memory use stays at one segment, so any size works, including
// in incognito where large in-memory files fail. `write(position, bytes)`
// must apply writes in call order.
export class StreamingMp4 {
  constructor(write) {
    this.write = write;
    this.tables = new Map();
    this.pos = 0;
    this.mdatStart = null;
  }

  // One segment from prepareFragment: `parts` (Uint8Arrays) and `trafs`.
  addFragment(parts, trafs) {
    if (this.mdatStart == null) {
      this.write(0, FTYP);
      this.mdatStart = FTYP.length;
      this.write(this.mdatStart, mdatHeader(0));
      this.pos = this.mdatStart + 16;
    }
    const bytes = parts.length === 1 ? parts[0] : concatBytes(parts);
    addSamples(this.tables, trafs, (run, chunk) => {
      chunk.offset = this.pos;
      this.write(this.pos, bytes.subarray(run.start, run.end));
      this.pos += run.end - run.start;
    });
  }

  finish(tracks) {
    if (this.mdatStart == null) throw new Error("No video data was written");
    for (const id of this.tables.keys()) if (!tracks.some((t) => t.id === id)) throw new Error(`Fragment references unknown track ${id}`);
    this.write(this.mdatStart, mdatHeader(this.pos - this.mdatStart - 16));
    this.write(this.pos, buildMoov(tracks, this.tables));
  }
}

function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
