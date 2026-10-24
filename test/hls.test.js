import assert from "node:assert/strict";
import { test } from "node:test";
import { isMaster, parseMaster, parseMedia, segmentIv } from "../hls.js";

const BASE = "https://cdn.example/show/master.m3u8";

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="fr",DEFAULT=YES,URI="audio/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://other.example/1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360
360p-hi.m3u8
`;

test("isMaster tells master playlists from media playlists", () => {
  assert.equal(isMaster(MASTER), true);
  assert.equal(isMaster("#EXTM3U\n#EXTINF:4,\nseg0.ts\n"), false);
});

test("parseMaster sorts by height, then bandwidth, and resolves URLs", () => {
  const variants = parseMaster(MASTER, BASE);
  assert.deepEqual(
    variants.map((v) => [v.url, v.height, v.bandwidth]),
    [
      ["https://other.example/1080p.m3u8", 1080, 3000000],
      ["https://cdn.example/show/360p-hi.m3u8", 360, 1200000],
      ["https://cdn.example/show/360p.m3u8", 360, 800000],
    ],
  );
  assert.equal(variants[0].averageBandwidth, 2500000);
});

test("parseMaster picks the DEFAULT audio rendition of a group", () => {
  const [, , low] = parseMaster(MASTER, BASE);
  assert.equal(low.audioUrl, "https://cdn.example/show/audio/fr.m3u8");
  assert.equal(parseMaster(MASTER, BASE)[0].audioUrl, null);
});

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg7.m4s
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1",IV=0x000102030405060708090A0B0C0D0E0F
#EXTINF:4.0,
seg8.m4s
#EXT-X-KEY:METHOD=NONE
#EXTINF:2.5,
seg9.m4s
#EXT-X-ENDLIST
`;

test("parseMedia numbers segments from the media sequence and tracks keys", () => {
  const { segments, map } = parseMedia(MEDIA, "https://cdn.example/show/720p.m3u8");
  assert.equal(map, "https://cdn.example/show/init.mp4");
  assert.deepEqual(
    segments.map((s) => [s.url, s.sequence, s.duration, s.key?.url ?? null]),
    [
      ["https://cdn.example/show/seg7.m4s", 7, 4, null],
      ["https://cdn.example/show/seg8.m4s", 8, 4, "https://keys.example/k1"],
      ["https://cdn.example/show/seg9.m4s", 9, 2.5, null],
    ],
  );
});

test("parseMedia rejects byte-range playlists", () => {
  assert.throws(() => parseMedia("#EXTM3U\n#EXT-X-BYTERANGE:1000@0\n#EXTINF:4,\nall.ts\n", BASE), /Byte-range/);
});

test("segmentIv uses the explicit IV when given", () => {
  const iv = segmentIv({ sequence: 3, key: { iv: "0x000102030405060708090A0B0C0D0E0F" } });
  assert.deepEqual([...iv], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("segmentIv defaults to the big-endian media sequence number", () => {
  const iv = segmentIv({ sequence: 0x01020304, key: { iv: null } });
  assert.deepEqual([...iv], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
});
