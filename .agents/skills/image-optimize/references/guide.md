# Image Optimize Reference Guide

## Overview
Optimize images for web: compress, resize, convert formats (WebP, AVIF), generate thumbnails, and set up responsive images. Use when the goal asks to optimize images, reduce image size, or add responsive images.

## # image-optimize

Optimize images for web: compress, resize, convert formats (WebP, AVIF), generate thumbnails, and set up responsive images. Use when the goal asks to optimize images, reduce image size, or add responsive images.

## Goal pattern

image optimize compress resize webp avif thumbnail responsive image optimization

## Parameters

- format (choice [default: auto]): Target format

## Steps

1. [analyst] Audit current images: identify formats, sizes, and dimensions. Find oversized or unoptimized assets.

2. [analyst] Choose optimization strategy: lossy vs lossless, target formats (WebP/AVIF), max dimensions, and quality settings. (after: step-0)

3. [analyst] Implement optimization pipeline: use sharp, imagemin, or squoosh to batch-compress images. Generate responsive variants (1x, 2x, 3x). (after: step-1)

4. [analyst] Set up lazy loading: add loading=lazy attributes, intersection observer fallback, and placeholder blur-up images. (after: step-2)

5. [analyst] Verify: compare file sizes before/after, check visual quality, test on slow connections, and document the pipeline. (after: step-3)

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
