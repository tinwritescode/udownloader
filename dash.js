// Minimal MPEG-DASH (static MPD) parsing: first Period, SegmentTemplate
// (number or timeline), SegmentList, or a single-file BaseURL.

function seconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(iso ?? "");
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}

const child = (el, name) => [...el.children].find((c) => c.localName === name) ?? null;
const children = (el, name) => [...el.children].filter((c) => c.localName === name);

function resolveBase(el, base) {
  const b = child(el, "BaseURL");
  return b ? new URL(b.textContent.trim(), base).href : base;
}

function fillTemplate(template, rep, number, time) {
  return template
    .replace(/\$\$/g, "$")
    .replace(/\$RepresentationID\$/g, rep.getAttribute("id"))
    .replace(/\$Bandwidth\$/g, rep.getAttribute("bandwidth"))
    .replace(/\$(Number|Time)(?:%0(\d+)d)?\$/g, (_, kind, width) => String(kind === "Number" ? number : time).padStart(Number(width ?? 0), "0"));
}

// Attributes on a Representation's SegmentTemplate override the AdaptationSet's.
function mergedTemplate(set, rep) {
  const outer = child(set, "SegmentTemplate");
  const inner = child(rep, "SegmentTemplate");
  if (!outer && !inner) return null;
  const attr = (name) => inner?.getAttribute(name) ?? outer?.getAttribute(name);
  return {
    media: attr("media"),
    initialization: attr("initialization"),
    startNumber: Number(attr("startNumber") ?? 1),
    timescale: Number(attr("timescale") ?? 1),
    duration: Number(attr("duration") ?? 0),
    timeline: child(inner ?? outer, "SegmentTimeline") ?? (outer && child(outer, "SegmentTimeline")),
  };
}

function templateSegments(t, rep, base, periodSeconds) {
  const urls = [];
  let number = t.startNumber;
  if (t.timeline) {
    let time = 0;
    for (const s of children(t.timeline, "S")) {
      if (s.hasAttribute("t")) time = Number(s.getAttribute("t"));
      const d = Number(s.getAttribute("d"));
      const repeat = Number(s.getAttribute("r") ?? 0);
      if (repeat < 0) throw new Error("Open-ended SegmentTimeline repeat is not supported");
      for (let i = 0; i <= repeat; i++) {
        urls.push(new URL(fillTemplate(t.media, rep, number++, time), base).href);
        time += d;
      }
    }
  } else {
    if (!t.duration || !periodSeconds) throw new Error("Cannot determine DASH segment count");
    const count = Math.ceil(periodSeconds / (t.duration / t.timescale));
    for (let i = 0; i < count; i++) urls.push(new URL(fillTemplate(t.media, rep, number++, 0), base).href);
  }
  return urls;
}

function representation(set, rep, base, periodSeconds) {
  const repBase = resolveBase(rep, base);
  const t = mergedTemplate(set, rep);
  let init = null;
  let segments;
  if (t) {
    init = t.initialization ? new URL(fillTemplate(t.initialization, rep, 0, 0), repBase).href : null;
    segments = templateSegments(t, rep, repBase, periodSeconds);
  } else if (child(rep, "SegmentList") ?? child(set, "SegmentList")) {
    const list = child(rep, "SegmentList") ?? child(set, "SegmentList");
    const initEl = child(list, "Initialization");
    init = initEl ? new URL(initEl.getAttribute("sourceURL"), repBase).href : null;
    segments = children(list, "SegmentURL").map((s) => new URL(s.getAttribute("media"), repBase).href);
  } else {
    // SegmentBase or bare BaseURL: the whole track is one file.
    segments = [repBase];
  }
  return {
    id: rep.getAttribute("id"),
    bandwidth: Number(rep.getAttribute("bandwidth")) || 0,
    width: Number(rep.getAttribute("width") ?? set.getAttribute("width")) || 0,
    height: Number(rep.getAttribute("height") ?? set.getAttribute("height")) || 0,
    init,
    segments: segments.map((url) => ({ url, key: null })),
  };
}

function kindOf(set, rep) {
  const type = `${rep.getAttribute("mimeType") ?? set.getAttribute("mimeType") ?? ""} ${set.getAttribute("contentType") ?? ""}`;
  if (type.includes("video")) return "video";
  if (type.includes("audio")) return "audio";
  return null;
}

export function parseMpd(text, mpdUrl) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const mpd = doc.documentElement;
  if (mpd.localName !== "MPD") throw new Error("Not a DASH manifest");
  if (mpd.getAttribute("type") === "dynamic") throw new Error("Live DASH streams are not supported");
  const period = child(mpd, "Period");
  if (!period) throw new Error("DASH manifest has no Period");
  if (children(period, "ContentProtection").length || doc.getElementsByTagNameNS("*", "ContentProtection").length) {
    throw new Error("DRM-protected DASH streams are not supported");
  }
  const periodSeconds = seconds(period.getAttribute("duration")) || seconds(mpd.getAttribute("mediaPresentationDuration"));
  const base = resolveBase(period, resolveBase(mpd, mpdUrl));
  const tracks = { video: [], audio: [], seconds: periodSeconds };
  for (const set of children(period, "AdaptationSet")) {
    const setBase = resolveBase(set, base);
    for (const rep of children(set, "Representation")) {
      const kind = kindOf(set, rep);
      if (kind) tracks[kind].push(representation(set, rep, setBase, periodSeconds));
    }
  }
  tracks.video.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  tracks.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return tracks;
}
