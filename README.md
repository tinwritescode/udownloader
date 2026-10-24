# uDownloader

Chrome MV3 extension that detects videos on the current page and downloads them locally. It makes no calls to any external service; every request goes to the site that serves the video.

## Supported

- Direct files (mp4, webm, mov, mkv, m4v), 300 KB or larger.
- Direct files go through Chrome's own downloader (straight to disk, any size) when the server allows it, otherwise through the extension with the page Referer.
- HLS: master and media playlists, AES-128 encryption, separate audio renditions. TS segments are converted to MP4 one at a time as they arrive (`vendor/muxjs`, H.264/AAC).
- DASH (static MPD, first Period): SegmentTemplate (number or timeline), SegmentList, single-file BaseURL. The best audio track is merged in.

Separate audio and video tracks are merged at the MP4 box level (`fmp4.js`): one moov with both tracks, fragments interleaved by time. None of this needs the whole video in memory at once, so it works for multi-GB videos. ffmpeg.wasm (`vendor/ffmpeg`) is only a fallback for small inputs that can't be handled that way (e.g. HEVC in TS). If that fails too, the original tracks are saved with correct video types and extensions.

## Not supported

Live streams, DRM (Widevine and similar, SAMPLE-AES), HLS byte-range playlists, and `blob:`/MSE videos whose real requests never appear in network traffic.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and choose this folder.

## How it works

- `background.js` sniffs media responses through `webRequest` and stores them per tab in `chrome.storage.session`. It also adds a Referer/Origin `declarativeNetRequest` session rule for the download tab.
- `popup.js` lists the detected media and opens `download.html` for the chosen item.
- `download.js` fetches the data, using `hls.js` and `dash.js` to parse playlists, mux.js to convert TS, `fmp4.js` to merge tracks, and `mux.js` (ffmpeg.wasm) as the fallback.

## Licenses

mux.js 7.0.3 is Apache-2.0. ffmpeg.wasm (`@ffmpeg/ffmpeg` 0.12.10, `@ffmpeg/core` 0.12.6) is MIT. The core binary includes FFmpeg built with GPL components (x264). Check the terms before you distribute.
