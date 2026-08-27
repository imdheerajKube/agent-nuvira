# Pwa Builder Reference Guide

## Overview
Build a Progressive Web App: service workers, offline support, push notifications, app manifest, and installability. Use when the goal is to create an installable web app with offline capabilities.

## # pwa-builder

Build a Progressive Web App: service workers, offline support, push notifications, app manifest, and installability. Use when the goal is to create an installable web app with offline capabilities.

## Goal pattern

PWA progressive web app service worker offline push notifications manifest installable

## Steps

0. [context-gatherer] Map the PWA requirements: what offline pages needed? What push notification provider? What caching strategy? What install experience?

1. [planner] Design the PWA:
1. Manifest: name, icons, theme color, display: standalone
2. Service worker: cache-first for static, network-first for API
3. Offline: offline page, cached assets, background sync
4. Push notifications: Web Push API, notification permissions
5. Installability: manifest + service worker = install prompt
6. Update: service worker update flow with user notification (after: 'step-0')

2. [runner] Build the PWA:
1. Create web manifest with icons
2. Register service worker
3. Implement caching strategies
4. Add offline fallback page
5. Set up push notifications
6. Test installability (after: 'step-1')

3. [reviewer] Verify: offline mode works, push notifications received, app installs, service worker updates correctly. (after: 'step-2')

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
