# uDownloader

[![CI](https://github.com/tinwritescode/udownloader/actions/workflows/ci.yml/badge.svg)](https://github.com/tinwritescode/udownloader/actions/workflows/ci.yml)

Chrome MV3 extension that detects videos on the current page and downloads them locally. It makes no calls to any external service; every request goes to the site that serves the video.

## Supported

- Direct files (mp4, webm, mov, mkv, m4v), 300 KB or larger.
- Direct files go through Chrome's own downloader (straight to disk, any size) when the server allows it, otherwise through the extension with the page Referer.
- HLS: master and media playlists, AES-128 encryption, separate audio renditions. TS segments are converted to MP4 one at a time as they arrive (`vendor/muxjs`, H.264/AAC).
- DASH (static MPD, first Period): SegmentTemplate (number or timeline), SegmentList, single-file BaseURL. The best audio track is merged in.

Separate audio and video tracks are merged at the MP4 box level (`fmp4.js`): one moov with both tracks, fragments interleaved by time. None of this needs the whole video in memory at once, so it works for multi-GB videos. ffmpeg.wasm (`vendor/ffmpeg`) is only a fallback for small inputs that can't be handled that way (e.g. HEVC in TS). If that fails too, the original tracks are saved with correct video types and extensions.

## Not supported

- DRM (Widevine, PlayReady, FairPlay, SAMPLE-AES). The extension does not try to get around copy protection.
- Live streams. Dynamic DASH is refused, and a live HLS playlist only yields the segments listed at the moment it was loaded.
- `blob:`/MSE players whose real requests never appear in network traffic.
- Byte-range segments: HLS `#EXT-X-BYTERANGE` playlists and DASH SegmentLists that use `mediaRange` (for example ffmpeg `-single_file` output).
- HLS discontinuities (`#EXT-X-DISCONTINUITY`, often inserted ads) can break the TS-to-MP4 conversion.
- DASH manifests with more than one Period: only the first Period is downloaded.
- Firefox and Safari. Chromium browsers only (Chrome, Edge, Brave), version 102 or later.

## Install

### From a release

1. Download `udownloader-vX.Y.Z.zip` from the [latest release](https://github.com/tinwritescode/udownloader/releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click "Load unpacked" and choose the unzipped folder.

The extension is not on the Chrome Web Store. To update, unzip the new release over the same folder and click the reload icon on `chrome://extensions`.

### From source

Needs Node.js 22 or later.

```sh
git clone https://github.com/tinwritescode/udownloader.git
cd udownloader
npm ci
npm run vendor   # copies ffmpeg.wasm and mux.js into vendor/
```

Then load the folder with "Load unpacked" as above.

## Usage

Play the video on the page, then click the uDownloader icon. The popup lists the detected media for the tab. Click the save button next to one; a download page opens next to the tab and saves the file to your Downloads folder. Keep that page open until it says the video is saved. In incognito windows you'll be asked where to save the file.

## Privacy and permissions

uDownloader has no analytics and no servers. It never sends data anywhere except to the sites that host the videos you download, and the list of detected media is kept only in the browser session.

| Permission | Why |
| --- | --- |
| `webRequest`, `<all_urls>` | Watch network responses to detect video files and stream manifests on any site. |
| `declarativeNetRequest` | Send the page's Referer and Origin with download requests, which many video hosts require. |
| `downloads` | Save the finished video to disk. |
| `storage` | Keep each tab's detected media in session storage, which the browser clears on exit. |
| `tabs` | Read the current tab's title and URL to name the file and open the download page. |

## FAQ

**The popup says no videos were found.** Start playing the video first, then open the popup again. Some players only request the stream once playback begins.

**The download stops with an error.** Check the "Not supported" list above. If the page isn't covered there, [open an issue](https://github.com/tinwritescode/udownloader/issues/new/choose) with the page URL and the console output of the download page.

**I got separate video and audio files.** Merging into one MP4 failed for that stream, so the original tracks were saved instead. Most players can open them, or you can merge them with `ffmpeg -i video.ts -i audio.m4a -c copy out.mp4`.

## How it works

- `background.js` sniffs media responses through `webRequest` and stores them per tab in `chrome.storage.session`. It also adds a Referer/Origin `declarativeNetRequest` session rule for the download tab.
- `popup.js` lists the detected media and opens `download.html` for the chosen one.
- `download.js` fetches the data, using `hls.js` and `dash.js` to parse playlists, mux.js to convert TS, `fmp4.js` to merge tracks, and `mux.js` (ffmpeg.wasm) as the fallback.

See [GLOSSARY.md](GLOSSARY.md) for the terms used in the code and docs, and [docs/adr](docs/adr) for design decisions.

## Development

```sh
npm run lint      # Biome lint and format check (npm run format to fix)
npm test          # unit tests; the merge test also uses ffprobe if installed
npm run package   # builds dist/udownloader-v<version>.zip
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

uDownloader is for saving videos you have the right to download, such as your own uploads, freely licensed content, or videos whose terms allow it. You are responsible for complying with copyright law and the terms of service of the sites you use. The authors are not responsible for how the extension is used.

## License

[GPL-3.0](LICENSE). The bundled ffmpeg.wasm core includes FFmpeg built with GPL components (x264), which is why the extension is GPL ([ADR 0001](docs/adr/0001-gpl-3-license.md)). mux.js 7.0.3 is Apache-2.0 and `@ffmpeg/ffmpeg` 0.12.10 / `@ffmpeg/core` 0.12.6 are MIT; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
