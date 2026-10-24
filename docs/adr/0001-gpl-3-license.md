# License the extension under GPL-3.0

The bundled ffmpeg.wasm core (`@ffmpeg/core` 0.12.6) is FFmpeg built with GPL components (x264), so distributing it inside a permissively licensed extension is not allowed. We license uDownloader as GPL-3.0 instead of rebuilding an LGPL-only core or dropping the ffmpeg fallback.

## Considered Options

- **MIT/Apache with a custom LGPL ffmpeg.wasm build (no x264)**: permissive, but we would have to maintain our own wasm build.
- **MIT/Apache without the ffmpeg fallback**: permissive, but inputs that the box-level merge and mux.js can't handle (e.g. HEVC in TS) would only be saved as raw tracks.

## Consequences

Forks and redistributions must stay GPL-3.0. Switching to a permissive license later means removing or replacing the GPL core first.
