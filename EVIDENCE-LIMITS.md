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

## 4. Performance: Emulated Mobile and Desktop Headless vs Physical Mid-Tier Mobile
- **The Gap:** Two different setups produced the performance numbers in this repository, and they are not comparable:
  - The `airhorn-df1` campaign numbers (median first paint ~1.4-1.7 s across the recorded runs, INP 144 ms cold / 56 ms warm) came from an ad-hoc CDP setup used by that campaign: Slow 4G (1.6 Mbps down / 150 ms RTT), 4x CPU throttling, a 412x915 @2.625 DPR mobile+touch viewport, a fresh isolated browser context per run, against `vite preview` on loopback.
  - The checked-in tool `tools/measure-perf.mjs` applies **no** CPU throttling, **no** network throttling and **no** viewport override - it only drives `Page`, `Runtime`, `Network` and `Input`, never `Emulation`. It measures unthrottled desktop headless Chrome at the default viewport, so its checked-in report (`preview/CWV-report.txt`: FP 104 ms cold / 52 ms repeat, INP p98 16 ms / 32 ms, no LCP entries recorded) is a desktop-class result, not a mobile one. Re-running the tool on this VM reproduces that class of number (FP ~100 ms cold), roughly an order of magnitude faster than the emulated mobile figures above - so the checked-in tool flatters the app: it measures a fast desktop machine with a warm local server, not a phone.
  - Both setups share one limitation: the measurement host is a shared x86-64 cloud VM, not a phone.
- **Unverified Traps:** Emulated CPU throttling scales timer loops linearly, but misses ARM memory bus contention, thermal throttling, low-memory tab eviction, and cellular radio jitter - and only the `airhorn-df1` campaign emulated a mobile CPU at all. Furthermore, Lighthouse is unusable on this box: a Lighthouse run in `airhorn-df1` failed with `NO_FCP` while the page demonstrably painted (screenshot captured), so standard Lighthouse scores are absent. That failure is recorded once in the `airhorn-df1` comments; no Lighthouse artifacts or run logs are checked in, so treat the failure as the reproducible symptom, not as a measured failure rate.
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
