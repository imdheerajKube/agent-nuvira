---
name: motion
description: Create an animated video — explainer, animated chart of real data, kinetic title, or code walkthrough — with the motion_render tool. Use when the goal is animation, motion graphics, an animated explainer, or turning data or a document into a video. The animation is code, rendered frame-accurately, so the same source always renders the same file and a revision re-renders the stored source.
version: 1.0.0
---

# motion

Create an animated video — explainer, animated chart of real data, kinetic title, or code walkthrough — with the motion_render tool. Use when the goal is animation, motion graphics, an animated explainer, or turning data or a document into a video. The animation is code, rendered frame-accurately, so the same source always renders the same file and a revision re-renders the stored source.

## Goal pattern

animated video explainer motion graphics animate chart kinetic text short video from data or document storyboard mp4 gif reels

## Parameters

(none)

## Steps

1. [context-gatherer] Establish: what is the message (one sentence), who is watching, and where will it play (16:9 screen, 9:16 phone, 1:1 feed)? Is there real DATA to animate (a CSV/JSON on disk, numbers in the request) or is this text-only? Is there narration, brand colours, a logo, a length limit? A missing answer here becomes a re-render later.

2. [planner] Decide CODE or PRESET, then storyboard. Preset first — bar-race, line-reveal, code-walkthrough, title-card are known-good scenes and take real data (data or data_path), so hand-written code is only for a shape no preset covers. Storyboard as a table: scene, seconds, on-screen text (VERBATIM, since it is what the viewer reads), data used. Budget: a scene under 1.5s reads as a flash, an explainer is usually 8-25s, and the text must survive being read while it animates. Choose fps (30 is the default; 12-15 is enough for text-only motion), aspect_ratio, format (mp4, or gif when it must autoplay in a chat with no sound), narration text, and captions as from_ms/to_ms cues. (after: step-0)

3. [runner] Render it. A preset: motion_render with preset + data + the storyboard settings. Hand-written: motion_render with html (or html_path), a self-contained page — inline CSS/JS/SVG, NO network (no CDN font, no chart library, no image URL), because a render must work offline and a fetched dependency would change the output. It must be SEEKABLE: define window.__motion = { seek(tMs) } that puts the page in its state for time t (or animate with CSS/Web Animations, or a requestAnimationFrame loop, both of which are stepped for you). NEVER drive motion from Date.now() or a counter: only a pure function of t renders reproducibly. Escape any text that came from the user. Then read the result: frames, duration, size, the seek mechanism, every warning. (after: step-1)

4. [reviewer] Verify the FILE, not the intent: the reported duration and frame count match the storyboard, and the seek line does not say STATIC (not seekable) — that means the animation ignores the timeline and the video is a still sequence, which is a bug to fix, not a result to deliver. If narration was asked for, confirm it was muxed rather than skipped. Then revise with the render id instead of re-authoring: motion_render action:revise with source_id re-renders the STORED source, so a fix to scene 3 cannot silently change scenes 1-2. Report the artifact path and what it shows. (after: step-2)
