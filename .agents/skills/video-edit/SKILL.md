---
name: video-edit
description: Edit and process videos with FFmpeg: cutting, merging, encoding, format conversion, subtitle overlay, and compression. Use when the goal is to manipulate video files programmatically.
version: 1.0.0
---

# video-edit

Edit and process videos with FFmpeg: cutting, merging, encoding, format conversion, subtitle overlay, and compression. Use when the goal is to manipulate video files programmatically.

## Goal pattern

video edit ffmpeg cut merge compress convert subtitle encode transcode format

## Steps

0. [context-gatherer] Map the task: input format(s)? Desired output format? What edits needed (cut, merge, overlay, resize)? Quality requirements? File size constraints?

1. [planner] Plan the FFmpeg commands:
1. Probing: ffprobe to get codec, resolution, duration info
2. Cutting: -ss and -t flags for precise cuts
3. Merging: concat demuxer or filter
4. Encoding: codec selection (H.264, H.265, VP9, AV1)
5. Compression: CRF quality, bitrate control, two-pass
6. Subtitles: SRT/ASS overlay with styling
7. Thumbnail extraction: single frame at timestamp (after: 'step-0')

2. [runner] Execute the video processing:
1. Probe input file for metadata
2. Apply edits in sequence
3. Export to target format
4. Verify output quality
5. Check file size meets requirements (after: 'step-1')

3. [reviewer] Verify: play output, check quality, verify duration, check file size, confirm all edits applied correctly. (after: 'step-2')
