---
name: pwa-builder
description: Build a Progressive Web App: service workers, offline support, push notifications, app manifest, and installability. Use when the goal is to create an installable web app with offline capabilities.
version: 1.0.0
---

# pwa-builder

Build a Progressive Web App: service workers, offline support, push notifications, app manifest, and installability. Use when the goal is to create an installable web app with offline capabilities.

## Goal pattern

PWA progressive web app service worker offline push notifications manifest installable

## Parameters

(none)

## Steps

1. [context-gatherer] Map the PWA requirements: what offline pages needed? What push notification provider? What caching strategy? What install experience?

2. [planner] Design the PWA:
1. Manifest: name, icons, theme color, display: standalone
2. Service worker: cache-first for static, network-first for API
3. Offline: offline page, cached assets, background sync
4. Push notifications: Web Push API, notification permissions
5. Installability: manifest + service worker = install prompt
6. Update: service worker update flow with user notification (after: step-0)

3. [runner] Build the PWA:
1. Create web manifest with icons
2. Register service worker
3. Implement caching strategies
4. Add offline fallback page
5. Set up push notifications
6. Test installability (after: step-1)

4. [reviewer] Verify: offline mode works, push notifications received, app installs, service worker updates correctly. (after: step-2)
