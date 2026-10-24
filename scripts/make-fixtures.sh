#!/usr/bin/env bash
# Regenerates the tiny fMP4 fixtures in test/fixtures (needs ffmpeg).
# Video and audio are separate fMP4 tracks, each an init segment plus
# two 1-second media segments, like an HLS fMP4 or DASH stream.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ffmpeg -loglevel error -f lavfi -i testsrc=size=64x64:rate=10 -t 2 -c:v libx264 -g 10 -pix_fmt yuv420p \
  -f hls -hls_time 1 -hls_segment_type fmp4 -hls_fmp4_init_filename video-init.mp4 \
  -hls_segment_filename "$tmp/video-%d.m4s" "$tmp/video.m3u8"
ffmpeg -loglevel error -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 -c:a aac -b:a 32k \
  -f hls -hls_time 1 -hls_segment_type fmp4 -hls_fmp4_init_filename audio-init.mp4 \
  -hls_segment_filename "$tmp/audio-%d.m4s" "$tmp/audio.m3u8"

mv "$tmp"/video-init.mp4 "$tmp"/audio-init.mp4 .
for kind in video audio; do
  i=0
  for f in $(ls "$tmp"/$kind-*.m4s | sort -V); do
    mv "$f" "$kind-$i.m4s"
    i=$((i + 1))
  done
done
ls -l
