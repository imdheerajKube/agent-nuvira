# Mobile Bridge Reference Guide

## Overview
Bridge web and native mobile: Capacitor, Cordova, or React Native bridge for accessing native device features from web code. Use when adding native mobile capabilities to a web application.

## # mobile-bridge

Bridge web and native mobile: Capacitor, Cordova, or React Native bridge for accessing native device features from web code. Use when adding native mobile capabilities to a web application.

## Goal pattern

mobile bridge capacitor cordova react native native features camera GPS push notifications

## Steps

0. [context-gatherer] Map the native features: what device APIs needed (camera, GPS, push notifications, biometrics)? What framework? iOS and/or Android?

1. [planner] Design the mobile bridge:
1. Framework: Capacitor (modern, recommended), Cordova (legacy), or React Native
2. Native plugins: camera, geolocation, push notifications, haptics
3. Build: platform-specific build configuration
4. Testing: device testing, emulator testing
5. Distribution: App Store, Play Store, or sideloading
6. Updates: code push or app store updates (after: 'step-0')

2. [runner] Implement the bridge:
1. Add Capacitor/Cordova to the web project
2. Install native plugins
3. Configure platform builds
4. Implement native feature calls
5. Test on device/emulator
6. Build for distribution (after: 'step-1')

3. [reviewer] Verify: native features work on device, performance acceptable, no memory leaks, app store build succeeds. (after: 'step-2')

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
