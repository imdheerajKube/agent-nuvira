# Video Edit Reference Guide

## Overview
Edit and process videos with FFmpeg: cutting, merging, encoding, format conversion, subtitle overlay, and compression. Use when the goal is to manipulate video files programmatically.

## # video-edit

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

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
