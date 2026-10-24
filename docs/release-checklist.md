# Release checklist

1. Update `version` in both `manifest.json` and `package.json`.
2. Move the `[Unreleased]` entries in `CHANGELOG.md` into a new version section and update the compare links.
3. Run `npm run lint`, `npm test`, `npm run vendor`, and `npm run package`.
4. Unzip `dist/udownloader-v<version>.zip` into an empty folder, load it unpacked in a clean Chrome profile, and check the manual matrix below.
5. Commit, tag `v<version>`, and push the tag. The Release workflow publishes the zip.

## Manual test matrix

| Case | Expected |
| --- | --- |
| Direct mp4 under 50 MB | Saved by Chrome's downloader, plays |
| Direct file over 1 GB | Large-size note shown, saved, plays |
| Direct file that needs a Referer | Falls back to the in-page download, plays |
| HLS with TS segments | Converted to one MP4 with audio, seeks |
| HLS with fMP4 segments (`#EXT-X-MAP`) | One MP4, seeks |
| HLS with AES-128 | Decrypted, plays |
| HLS with a separate audio rendition | One MP4 with both tracks in sync |
| HLS master with several qualities | Quality picker shows sizes; chosen one is saved |
| DASH SegmentTemplate (number and timeline) | One MP4 with audio |
| DASH single-file BaseURL | Saved, plays |
| DRM page | Clear "not supported" message |
| Incognito window | Save dialog, file written |
| Closing the download page mid-download | Leave-page prompt shown |
