# Contributing

Thanks for helping. Bug reports with a page URL and the download page's console output are the most useful contribution.

## Setup

```sh
npm ci
npm run vendor
```

Load the folder with "Load unpacked" on `chrome://extensions`. After editing, click the reload icon there; reopen the popup and download page to pick up changes.

## Before opening a pull request

- `npm run lint` passes (`npm run format` fixes formatting).
- `npm test` passes. Install ffmpeg to also run the ffprobe check of the merge test.
- You loaded the extension and downloaded a video of each kind your change touches (direct file, HLS, DASH).
- New parsing or merging behavior has a unit test in `test/`. `scripts/make-fixtures.sh` regenerates the fMP4 fixtures.
- User-facing text uses the terms in [GLOSSARY.md](GLOSSARY.md).

## Scope

The extension stays free of external services: no analytics, no remote code, and no requests except to the site that serves the video. Pull requests that get around DRM or other copy protection will not be accepted.

## License

By contributing, you agree that your contributions are licensed under the [GPL-3.0](LICENSE).
