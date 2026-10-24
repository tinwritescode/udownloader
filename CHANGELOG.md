# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-24

### Added

- Detection of direct video files, HLS playlists, and DASH manifests in any tab.
- Direct file downloads through Chrome's downloader, with a Referer fallback.
- HLS downloads: master and media playlists, AES-128, separate audio renditions, TS converted to MP4 segment by segment.
- DASH downloads (static, first Period): SegmentTemplate, SegmentTimeline, SegmentList, and single-file BaseURL, with the best audio track merged in.
- Box-level merging of separate video and audio into one regular MP4, with ffmpeg.wasm as a fallback for small inputs.
- Incognito support through a save dialog.

[Unreleased]: https://github.com/tinwritescode/udownloader/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tinwritescode/udownloader/releases/tag/v0.1.0
