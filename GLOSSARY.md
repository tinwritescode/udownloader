# uDownloader

A browser extension that finds the videos a page plays and saves them to the user's disk, without any external service.

## Language

**Detected media**:
A video source seen in a tab's network traffic and offered for download from the popup.
_Avoid_: Item, video (for the entry itself)

**Direct file**:
Detected media that is a single complete video file (mp4, webm, mov, mkv, m4v).
_Avoid_: Plain file, progressive download

**Stream**:
Detected media described by a manifest (HLS playlist or DASH MPD) and split into many segments.
_Avoid_: Playlist (for the whole thing), manifest (for the media itself)

**Track**:
One elementary media type of a stream, either video or audio, downloaded separately and merged into one output.
_Avoid_: Rendition, variant (outside HLS playlist discussion)

**Segment**:
One downloadable piece of a track, as listed by the manifest.
_Avoid_: Chunk, part

**Fragment**:
A segment after it has been normalised to fragmented MP4, ready to be merged by decode time.
_Avoid_: Chunk

**Raw tracks**:
The original, unmerged tracks saved as separate files when no merge or conversion succeeds.
_Avoid_: Fallback files
