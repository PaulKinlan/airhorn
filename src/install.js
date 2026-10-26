/*
 * src/install.js — the install affordance (airhorn-fld, airhorn-slmt).
 *
 * Structurally inert until an install is actually offered: the disabled
 * attribute lives on the button, not in CSS, so even the blocked-CSS fallback
 * shows an honest control - nothing exposed that clicking does nothing.
 * beforeinstallprompt enables it.
 */

import { trackEvent } from './analytics.js';

class Installer {
  #promptEvent = null;
  #button;
  #root;

  constructor(root) {
    this.#root = root;
    this.#button = root.querySelector('button');
    if (this.#button) this.#button.disabled = true;

    window.addEventListener('beforeinstallprompt', (e) => {
      this.#promptEvent = e;
      e.preventDefault();
      if (this.#button) this.#button.disabled = false;
      root.classList.add('available');
      trackEvent('install_available');
    });

    window.addEventListener('appinstalled', () => {
      this.#promptEvent = null;
      // An installed app is not offered another prompt; stay honest.
      if (this.#button) this.#button.disabled = true;
      this.#restoreFocus();
      root.classList.remove('available');
      trackEvent('app_installed');
    });

    root.addEventListener('click', () => this.#install());
  }

  #restoreFocus() {
    if (this.#root.contains(document.activeElement)) {
      const hornButton = document.querySelector('.horn');
      if (hornButton && typeof hornButton.focus === 'function') {
        hornButton.focus();
      }
    }
  }

  async #install() {
    if (!this.#promptEvent) return;
    this.#promptEvent.prompt();
    const result = await this.#promptEvent.userChoice;
    trackEvent('install_prompt_result', { outcome: result.outcome });
    this.#promptEvent = null;
    if (this.#button) this.#button.disabled = true;
    this.#restoreFocus();
    this.#root.classList.remove('available');

    // The outcome goes through the one polite voice (airhorn-fld). The old
    // code wrote it to #install-status, an element that does not exist, so
    // accepting or dismissing the prompt was silent.
    window.__airhornAnnounce?.(result?.outcome === 'accepted' ? 'App installed' : 'Installation cancelled');
  }
}

export function bindInstaller(root) {
  return new Installer(root);
}
