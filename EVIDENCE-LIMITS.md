# Limits of Test Evidence

All automated test passes and performance benchmarks in this repository were produced by a synthetic harness on a single Linux VM running Chromium. They provide narrow regression confidence, not proof of real-world fitness. Paul should use this document to evaluate what our evidence does NOT cover before making a ship decision.

## 1. Engine Monoculture: Chromium Only (Zero WebKit or Gecko)
- **The Gap:** Every automated browser test runs in Google Chrome 155.0 on this VM. Running `which firefox firefox-esr epiphany` returns nothing (all not found). WebKit (Safari / iOS) and Gecko (Firefox) behaviour is 100% unverified.
- **Unverified Traps:** WebKit/iOS Safari does not support `beforeinstallprompt` (the Install button will never appear on iOS; installation is purely manual via Share sheet); WebKit requires strict synchronous user gesture handling to unlock `AudioContext`; iOS hardware mute switch silences Web Audio unless specific audio sessions are configured.
- **What Closes the Gap:** Per-engine CI runner matrix (Playwright running WebKit and Firefox) plus a manual smoke test on an iPhone running Safari.
- **Estimated Cost:** ~3 hours setup; free on GitHub Actions Linux runners, ~$0.08/min for macOS runners.

## 2. Audio Verification: Synthetic Probes vs Real Ears
- **The Gap:** No physical device, no real touch screen, and no real speakers were used. In `tests/acceptance.mjs` and `tests/shortcuts.test.mjs`, audio correctness is asserted by attaching an `AnalyserNode` probe checking `getFloatTimeDomainData` peak amplitude > 0.3. In unit tests (`tests/horn.test.js`), Web Audio is mocked entirely with `FakeAudioNode` and `FakeAudioContext`.
- **Unverified Traps:** Hardware DAC clipping, touch-to-sound latency, OS audio ducking/interruption (phone calls, backgrounding), and acoustic timbre. The synthesised fallback voice is mathematical oscillators lacking the sample's noise bed (`airhorn-63s`).
- **What Closes the Gap:** Human listening test on physical hardware (iPhone, Android phone, laptop) comparing the MP3 blast and fallback synth.
- **Estimated Cost:** ~30 minutes manual testing; $0.

## 3. Install Prompt: Localhost / Self-Signed HTTPS vs Real Public HTTPS
- **The Gap:** The install proof (`tools/install-https-proof.mjs`) ran against `airhorn.test` on loopback using a self-signed certificate, requiring `--ignore-certificate-errors-spki-list`, `--host-resolver-rules`, and `--no-sandbox`.
- **Unverified Traps:** Genuine CA chain validation, Android WebAPK generation, Chrome user-engagement thresholds, and public HTTPS service worker security. Also, `DEPLOY.md` flags that `public/.well-known/assetlinks.json` has legacy TWA signing fingerprints (`com.airhorner.twa`) that break Android deep links if deployed unchanged.
- **What Closes the Gap:** Deploy `dist/` to a public staging origin with a trusted certificate (Cloudflare Pages or Firebase) and verify installation on a physical Android phone.
- **Estimated Cost:** ~1 hour setup; $0 (free-tier static hosting).

## 4. Performance: CDP Emulation vs Physical Mid-Tier Mobile
- **The Gap:** All Core Web Vitals and load numbers (`airhorn-df1`, `tools/measure-perf.mjs`) derive from DevTools CDP throttling: 4x CPU slowdown, Slow 4G (1.6 Mbps / 150 ms RTT), and a 412x915 viewport on an x86-64 cloud VM.
- **Unverified Traps:** Emulated CPU throttling scales timer loops linearly, but misses ARM memory bus contention, thermal throttling, low-memory tab eviction, and cellular radio jitter. Furthermore, Lighthouse failed 9/9 runs with `NO_FCP` due to headless CDP lifecycle quirks, so standard Lighthouse scores are absent.
- **What Closes the Gap:** Automated runs on a physical device farm (BrowserStack, Firebase Test Lab) or manual runs on a physical Moto G or Pixel.
- **Estimated Cost:** ~1 hour manual testing ($0) or ~$30-$50/month device cloud subscription.

## 5. WebMCP: Flag-Dependent API vs Default Web Reality
- **The Gap:** WebMCP (`document.modelContext`) requires launching Chrome with `--enable-features=WebMCP,WebMCPTesting`. In `tests/acceptance.mjs`, when the flag is absent, the suite injects an in-memory JS stand-in shim (`window.__webmcpSource = 'stand-in'`).
- **Unverified Traps:** No shipping consumer browser enables WebMCP by default. Unflagged browsers execute a no-op registration path; tests do not measure how real in-page agents or screen readers interact with the app in ordinary consumer environments.
- **What Closes the Gap:** Automated test assertions confirming graceful degradation on clean, unflagged browser channels.
- **Estimated Cost:** ~30 minutes writing negative-path assertions; $0.

## 6. Test Shims and Synthetic Harness Limitations
- **The Gap:** Multiple core features rely on artificial test shims rather than platform delivery:
  - **Launch Queue:** `tests/shortcuts.test.mjs` shims `window.launchQueue` consumer dispatch because headless Chrome cannot trigger OS desktop shortcut launches.
  - **Badging:** `tests/acceptance.mjs` mocks `navigator.setAppBadge` / `clearAppBadge` with JS spies because Linux headless Chrome lacks a dock badge provider.
  - **Pointer Input:** CDP `Input.dispatchMouseEvent` dispatches coordinates with mathematical precision; real touch latency, touch slop, and gesture cancellation are unexercised.
  - **Multi-Tab Coherence:** Concurrent tab audio contention and background tab SW eviction are unverified (`airhorn-dae` remains open).
- **What Closes the Gap:** Physical device manual smoke pass testing home-screen shortcut launches, badging, touch responsiveness, and multi-tab playback.
- **Estimated Cost:** ~45 minutes manual testing; $0.
