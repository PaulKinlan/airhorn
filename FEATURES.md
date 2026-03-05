# Feature Ideas for Airhorn PWA

## 1. Sound Pack Selector
The project already has multiple sound files (short, long, alternative variants) that go unused. Add a sound picker UI so users can choose between different horn variations.

**Complexity:** Medium
**APIs:** Web Audio API (already in use)

## 2. Pitch / Speed Control
Use the Web Audio API's `playbackRate` and `detune` properties to let users adjust the horn's pitch. A few preset buttons (low, normal, high) or a slider.

**Complexity:** Low
**APIs:** AudioBufferSourceNode.playbackRate, AudioBufferSourceNode.detune

## 3. Vibration Feedback
Add haptic feedback on mobile devices when the horn is pressed using the Vibration API.

**Complexity:** Low
**APIs:** Navigator.vibrate()

## 4. Volume Control
Add a GainNode to the Web Audio graph to let users control horn volume independently of device volume.

**Complexity:** Low
**APIs:** GainNode (Web Audio API)

## 5. Honk Counter / Stats Page
Extend the existing badge counter into a persistent stats page using localStorage — total honks, longest honk duration, honks per session, all-time records.

**Complexity:** Medium
**APIs:** localStorage, Badge API (already in use)

## 6. Share Button (Web Share API)
Add a share button so users can share the app or their honk stats with friends.

**Complexity:** Low
**APIs:** Navigator.share()

## 7. Theme / Color Customization
Let users pick a horn color theme (red, blue, gold, neon green). Store preference in localStorage and apply via CSS custom properties.

**Complexity:** Low
**APIs:** CSS Custom Properties, localStorage

## 8. Record & Download
Let users record a custom honk sequence (multiple presses) and download it as an audio file.

**Complexity:** High
**APIs:** MediaRecorder, OfflineAudioContext, Blob

## 9. Keyboard Shortcut Visual Indicator
The app supports keyboard input (Space, Enter) but doesn't communicate this to users. Add a tooltip or hint for discoverability and accessibility.

**Complexity:** Low
**APIs:** None (HTML/CSS only)

## 10. Dark Mode
Add dark mode support using `prefers-color-scheme` media query with a manual toggle override.

**Complexity:** Low
**APIs:** CSS prefers-color-scheme, localStorage
