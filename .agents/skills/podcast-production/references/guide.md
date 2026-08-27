# Podcast Production Reference Guide

## Overview
Produce podcast audio: recording setup, noise reduction, audio normalization, chapter markers, RSS feed generation, and distribution. Use when the goal is to produce and distribute a podcast episode.

## # podcast-production

Produce podcast audio: recording setup, noise reduction, audio normalization, chapter markers, RSS feed generation, and distribution. Use when the goal is to produce and distribute a podcast episode.

## Goal pattern

podcast audio production recording noise reduction normalization RSS feed distribution chapters

## Steps

0. [context-gatherer] Map the production: how many tracks? What recording quality? What post-processing needed (noise reduction, normalization, compression)? What distribution (RSS, Spotify, Apple)?

1. [planner] Plan the production pipeline:
1. Audio processing: noise gate, noise reduction (RNNoise), EQ, compression
2. Loudness normalization: -16 LUFS for podcasts, -1 dBTP true peak
3. Chapter markers: insert chapter metadata
4. ID3 tags: title, artist, album art, episode number
5. RSS feed: iTunes/podcast namespace compliant XML
6. Distribution: submit to directories (Apple, Spotify, Google) (after: 'step-0')

2. [runner] Process the audio:
1. Apply noise reduction with sox or RNNoise
2. Normalize loudness to -16 LUFS
3. Add chapter markers
4. Embed ID3 metadata and album art
5. Generate RSS feed XML
6. Validate feed with podcast validator (after: 'step-1')

3. [reviewer] Verify: listen to processed audio, check loudness levels, verify chapter markers, validate RSS feed, test on podcast player. (after: 'step-2')

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
