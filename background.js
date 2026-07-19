/**
 * Background service worker — handles tab injection.
 *
 * Injects content.js into any pokemonshowdown.com tab that:
 *  - Was already open when the extension loads (onInstalled / onStartup)
 *  - Navigates to a new battle URL (onUpdated)
 *
 * content.js has a double-injection guard (window.__sdbActive) so running
 * this on a tab that already has the script is completely safe.
 */

const SHOWDOWN_PATTERN = "*://play.pokemonshowdown.com/*";

// ── Re-inject into all already-open Showdown tabs ────────────────────────────
function injectIntoExistingTabs() {
  chrome.tabs.query({ url: SHOWDOWN_PATTERN }, (tabs) => {
    for (const tab of tabs) {
      injectScript(tab.id);
    }
  });
}

// ── Inject when a tab finishes loading a Showdown URL ────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" &&
      tab.url && tab.url.includes("pokemonshowdown.com")) {
    injectScript(tabId);
  }
});

// ── Run on first install / browser startup ───────────────────────────────────
chrome.runtime.onInstalled.addListener(injectIntoExistingTabs);
chrome.runtime.onStartup.addListener(injectIntoExistingTabs);

// ── Core injection helper ─────────────────────────────────────────────────────
function injectScript(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  }).catch(() => {
    // Tab may be closed, a chrome:// page, or inaccessible — ignore silently.
  });
}
