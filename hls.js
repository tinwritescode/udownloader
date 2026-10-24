// Minimal HLS playlist parsing (RFC 8216) for downloading.

function parseAttributes(text) {
  const attrs = {};
  for (const m of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export function isMaster(text) {
  return text.includes("#EXT-X-STREAM-INF");
}

// Audio renditions by GROUP-ID; the DEFAULT one wins, else the first listed.
function audioGroups(all, baseUrl) {
  const groups = {};
  for (const line of all) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    const attrs = parseAttributes(line.slice(13));
    if (attrs.TYPE !== "AUDIO" || !attrs.URI) continue;
    const url = new URL(attrs.URI, baseUrl).href;
    if (!groups[attrs["GROUP-ID"]] || attrs.DEFAULT === "YES") groups[attrs["GROUP-ID"]] = url;
  }
  return groups;
}

export function parseMaster(text, baseUrl) {
  const variants = [];
  const all = lines(text);
  const audio = audioGroups(all, baseUrl);
  for (let i = 0; i < all.length; i++) {
    if (!all[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttributes(all[i].slice(18));
    const uri = all.slice(i + 1).find((l) => !l.startsWith("#"));
    if (!uri) continue;
    const [width, height] = (attrs.RESOLUTION ?? "").split("x").map(Number);
    variants.push({
      url: new URL(uri, baseUrl).href,
      bandwidth: Number(attrs.BANDWIDTH) || 0,
      averageBandwidth: Number(attrs["AVERAGE-BANDWIDTH"]) || 0,
      width,
      height,
      // A separate audio rendition means this variant's segments are video-only.
      audioUrl: audio[attrs.AUDIO] ?? null,
    });
  }
  return variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
}

export function parseMedia(text, baseUrl) {
  let sequence = 0;
  let key = null;
  let map = null;
  const segments = [];
  let duration = 0;
  for (const line of lines(text)) {
    if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice(11));
      key = attrs.METHOD === "NONE" ? null : { method: attrs.METHOD, url: new URL(attrs.URI, baseUrl).href, iv: attrs.IV ?? null };
    } else if (line.startsWith("#EXT-X-MAP:")) {
      map = new URL(parseAttributes(line.slice(11)).URI, baseUrl).href;
    } else if (line.startsWith("#EXT-X-BYTERANGE")) {
      throw new Error("Byte-range playlists are not supported");
    } else if (!line.startsWith("#")) {
      segments.push({ url: new URL(line, baseUrl).href, key, sequence: sequence + segments.length, duration });
      duration = 0;
    }
  }
  return { segments, map };
}

// Default IV is the segment's media sequence number as a 128-bit big-endian int.
export function segmentIv(segment) {
  const iv = new Uint8Array(16);
  if (segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, "").padStart(32, "0");
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, segment.sequence);
  }
  return iv;
}
