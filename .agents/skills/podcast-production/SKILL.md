---
name: podcast-production
description: Produce podcast audio: recording setup, noise reduction, audio normalization, chapter markers, RSS feed generation, and distribution. Use when the goal is to produce and distribute a podcast episode.
version: 1.0.0
---

# podcast-production

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
