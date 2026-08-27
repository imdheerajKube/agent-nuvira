---
name: mobile-bridge
description: Bridge web and native mobile: Capacitor, Cordova, or React Native bridge for accessing native device features from web code. Use when adding native mobile capabilities to a web application.
version: 1.0.0
---

# mobile-bridge

Bridge web and native mobile: Capacitor, Cordova, or React Native bridge for accessing native device features from web code. Use when adding native mobile capabilities to a web application.

## Goal pattern

mobile bridge capacitor cordova react native native features camera GPS push notifications

## Parameters

(none)

## Steps

1. [context-gatherer] Map the native features: what device APIs needed (camera, GPS, push notifications, biometrics)? What framework? iOS and/or Android?

2. [planner] Design the mobile bridge:
1. Framework: Capacitor (modern, recommended), Cordova (legacy), or React Native
2. Native plugins: camera, geolocation, push notifications, haptics
3. Build: platform-specific build configuration
4. Testing: device testing, emulator testing
5. Distribution: App Store, Play Store, or sideloading
6. Updates: code push or app store updates (after: step-0)

3. [runner] Implement the bridge:
1. Add Capacitor/Cordova to the web project
2. Install native plugins
3. Configure platform builds
4. Implement native feature calls
5. Test on device/emulator
6. Build for distribution (after: step-1)

4. [reviewer] Verify: native features work on device, performance acceptable, no memory leaks, app store build succeeds. (after: step-2)
