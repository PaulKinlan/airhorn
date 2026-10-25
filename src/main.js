/*
 *
 *  Air Horner
 *  Copyright 2015 Google Inc. All rights reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the 'License');
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License
 *
 */

// The composition root: this module WIRES the app and decides nothing about how
// any part of it behaves. Each concern lives in its own module - the horn's
// state (airhorn.js), input semantics (input.js), the app badge (badge.js), the
// install affordance (install.js), deep links and launches (launch.js), the
// connection notice (status.js) and analytics plumbing (analytics.js) - so a
// change to one concern runs that concern's suites, not every suite in the tree
// (airhorn-1l04). Keep it that way: behavioural code belongs in a concern
// module, and tests/modules.test.js fails if this file grows any.

import { registerHornTools } from './webmcp.js';
import { AirHorn } from './airhorn.js';
import { bindStatus } from './status.js';
import { bindInstaller } from './install.js';
import { bindHornInput } from './input.js';
import { bindLaunch } from './launch.js';

// The boot marker is NOT here: the watchdog's 'booted' means the horn is
// actually usable (airhorn-21k), so this module signals it from the load
// handler once the AirHorn is constructed and bound - a bundle that runs but
// fails during setup stays unbooted and the watchdog speaks.

// Connection status is bound at module scope, before load: a page opened
// offline says so once at boot, exactly as it did before the split.
bindStatus();

window.addEventListener('load', () => {
  const airhorn = new AirHorn(document.getElementById('airhorn'));
  window.__airhorn = airhorn;

  // Pointer + keyboard semantics. Bound before the installer, exactly as when
  // both lived in one constructor, so listener registration order is unchanged.
  bindHornInput({
    target: airhorn.element,
    start: (options) => airhorn.start(options),
    stop: (options) => airhorn.stop(options),
  });

  bindInstaller(document.getElementById('installer'));

  // The app is usable: retire the boot watchdog (airhorn-21k). This runs
  // synchronously inside load, always ahead of the watchdog's load+grace arm.
  window.__airhornBooted?.();

  registerHornTools(airhorn).catch(() => {
    // WebMCP is an enhancement: never let a registration failure break the horn.
  });

  bindLaunch({
    start: () => airhorn.start({ loop: false }),
    acknowledgeBadge: () => airhorn.acknowledgeSharedBadge(),
  });
});
