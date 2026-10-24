import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import { parseMpd } from "../dash.js";

globalThis.DOMParser = DOMParser;

const URL_ = "https://cdn.example/vod/manifest.mpd";
const mpd = (body, attrs = 'type="static" mediaPresentationDuration="PT10S"') =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrs}>${body}</MPD>`;

test("SegmentTemplate with $Number%05d$ and a fixed duration", () => {
  const tracks = parseMpd(
    mpd(`<Period>
      <AdaptationSet mimeType="video/mp4">
        <SegmentTemplate media="v/$RepresentationID$/$Number%05d$.m4s" initialization="v/$RepresentationID$/init.mp4" startNumber="1" timescale="1000" duration="4000"/>
        <Representation id="720" bandwidth="2000000" width="1280" height="720"/>
        <Representation id="1080" bandwidth="4000000" width="1920" height="1080"/>
      </AdaptationSet>
    </Period>`),
    URL_,
  );
  assert.equal(tracks.seconds, 10);
  assert.deepEqual(
    tracks.video.map((r) => r.id),
    ["1080", "720"],
  );
  const [best] = tracks.video;
  assert.equal(best.init, "https://cdn.example/vod/v/1080/init.mp4");
  assert.deepEqual(
    best.segments.map((s) => s.url),
    ["https://cdn.example/vod/v/1080/00001.m4s", "https://cdn.example/vod/v/1080/00002.m4s", "https://cdn.example/vod/v/1080/00003.m4s"],
  );
});

test("SegmentTimeline expands repeats and carries $Time$", () => {
  const tracks = parseMpd(
    mpd(`<Period><AdaptationSet contentType="audio" mimeType="audio/mp4">
      <SegmentTemplate media="a/$Time$.m4s" initialization="a/init.mp4" timescale="48000">
        <SegmentTimeline><S t="100" d="96000" r="2"/><S d="48000"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="aac" bandwidth="128000"/>
    </AdaptationSet></Period>`),
    URL_,
  );
  assert.deepEqual(
    tracks.audio[0].segments.map((s) => s.url.split("/").pop()),
    ["100.m4s", "96100.m4s", "192100.m4s", "288100.m4s"],
  );
});

test("SegmentList and nested BaseURL", () => {
  const tracks = parseMpd(
    mpd(`<BaseURL>https://media.example/root/</BaseURL><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="v" bandwidth="1" height="480"><BaseURL>480/</BaseURL>
        <SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/></SegmentList>
      </Representation>
    </AdaptationSet></Period>`),
    URL_,
  );
  const [rep] = tracks.video;
  assert.equal(rep.init, "https://media.example/root/480/init.mp4");
  assert.deepEqual(
    rep.segments.map((s) => s.url),
    ["https://media.example/root/480/s1.m4s", "https://media.example/root/480/s2.m4s"],
  );
});

test("a bare BaseURL is one single-file track", () => {
  const tracks = parseMpd(
    mpd(
      `<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet></Period>`,
    ),
    URL_,
  );
  assert.deepEqual(
    tracks.video[0].segments.map((s) => s.url),
    ["https://cdn.example/vod/video.mp4"],
  );
  assert.equal(tracks.video[0].init, null);
});

test("rejects live, DRM, and non-MPD documents", () => {
  assert.throws(() => parseMpd(mpd("<Period/>", 'type="dynamic"'), URL_), /Live DASH/);
  assert.throws(
    () =>
      parseMpd(
        mpd(
          `<Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></Period>`,
        ),
        URL_,
      ),
    /DRM/,
  );
  assert.throws(() => parseMpd("<html/>", URL_), /Not a DASH manifest/);
});
