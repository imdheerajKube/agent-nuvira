# Electron App Reference Guide

## Overview
Build an Electron desktop application: main process, renderer process, IPC communication, auto-updates, and native modules. Use when creating a desktop application with web technologies.

## # electron-app

Build an Electron desktop application: main process, renderer process, IPC communication, auto-updates, and native modules. Use when creating a desktop application with web technologies.

## Goal pattern

electron desktop app main process renderer IPC auto-update native modules packaging

## Steps

0. [context-gatherer] Map the Electron app: what does it do? What native features (file system, notifications, tray)? What framework for UI (React, Vue, Svelte)?

1. [planner] Design the Electron app:
1. Architecture: main process (Node.js) + renderer (web)
2. IPC: secure communication between processes
3. Native modules: file system, notifications, system info
4. Auto-update: electron-updater with GitHub releases
5. Packaging: electron-builder or electron-forge
6. Security: context isolation, no nodeIntegration, CSP headers (after: 'step-0')

2. [runner] Build the Electron app:
1. Set up Electron with TypeScript
2. Create main process with window management
3. Implement IPC communication
4. Add native features (notifications, file dialogs)
5. Configure auto-updater
6. Package for distribution (dmg, exe, AppImage) (after: 'step-1')

3. [reviewer] Verify: app launches, IPC works, native features functional, auto-update works, packaged app runs correctly. (after: 'step-2')

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
