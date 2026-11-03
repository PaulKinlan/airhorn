// The page authors this notice; resilience-ui supplies the live region's actual text.
// Keep the assertion pure so its failure can be proved without launching a browser.
export const LOST_UPGRADE_COPY = Object.freeze(['The app could not update', 'previous version']);

export function assertLostUpgradeNotice(text) {
  for (const copy of LOST_UPGRADE_COPY) {
    if (!text.includes(copy)) {
      throw new Error(`the lost-upgrade notice is missing "${copy}": ${JSON.stringify(text)}`);
    }
  }
}
