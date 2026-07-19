/**
 * Showdown Battle Test Bot - content script
 *
 * Watches the page for Showdown's move/switch/teampreview buttons and
 * auto-clicks one when it's your turn to choose. Intended for your own
 * unrated (direct-challenge / room) battles, for learning and bug
 * catching -- not for the ranked ladder.
 *
 * This script has NO way to detect whether a given battle is ranked or
 * not. Only enable it (via the popup) during battles you intend to test.
 *
 * Robustness notes:
 * - Each button type has a PRIMARY selector (Showdown's documented
 *   name= convention) and FALLBACK selectors (older class-based
 *   markup), tried in order.
 * - A MutationObserver AND a 1-second poll both trigger checks, so a
 *   missed DOM event can't silently stall the bot.
 * - If it's stuck for 10+ seconds with no recognized button found
 *   while battle UI is clearly present, it logs a diagnostic snapshot
 *   of the controls area so a selector fix can be made quickly.
 * - A small on-page badge shows live status without needing DevTools.
 */

const SELECTOR_SETS = {
  move: [
    'button[name="chooseMove"]:not([disabled])',
    ".movemenu button:not(.disabled)",
  ],
  switch: [
    'button[name="chooseSwitch"]:not([disabled])',
    ".switchmenu button:not(.disabled)",
  ],
  teamPreview: [
    'button[name="chooseTeamPreview"]:not([disabled])',
    ".teampreview button",
  ],
};

const ACTION_DELAY_MS = [300, 900];
const STUCK_THRESHOLD_MS = 10000;

let enabled = false;
let lastActedSignature = null;
let lastFoundAnyAt = Date.now();
let lastDiagnosticAt = 0;

function log(message) {
  const entry = { time: new Date().toISOString(), message };
  console.log("[ShowdownTestBot]", message);
  chrome.storage.local.get({ bugLog: [] }, (data) => {
    const bugLog = data.bugLog;
    bugLog.push(entry);
    while (bugLog.length > 500) bugLog.shift();
    chrome.storage.local.set({ bugLog });
  });
}

function queryFirstMatching(selectorList) {
  for (const sel of selectorList) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length > 0) return { buttons: found, selectorUsed: sel };
  }
  return { buttons: [], selectorUsed: null };
}

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function signatureFor(buttons) {
  return buttons.map((b) => b.outerHTML).join("|");
}

// ---------------------------------------------------------------------
// On-page status notifier — professional redesign
// States: 'off' | 'waiting' | 'active' | 'error'
// ---------------------------------------------------------------------

const BADGE_ID  = "sdb-notifier";
const STYLE_ID  = "sdb-notifier-style";

const BADGE_STATES = {
  off: {
    dot:   "#4b5563",
    label: "#9ca3af",
    bg:    "rgba(17,19,24,0.92)",
    border:"rgba(55,65,81,0.7)",
    icon:  svgPause(),
  },
  waiting: {
    dot:   "#f5a623",
    label: "#f5a623",
    bg:    "rgba(17,19,24,0.94)",
    border:"rgba(245,166,35,0.25)",
    icon:  svgClock(),
  },
  active: {
    dot:   "#34c77b",
    label: "#e2e8f0",
    bg:    "rgba(17,19,24,0.94)",
    border:"rgba(52,199,123,0.28)",
    icon:  svgPlay(),
  },
  error: {
    dot:   "#ef4444",
    label: "#fca5a5",
    bg:    "rgba(17,19,24,0.94)",
    border:"rgba(239,68,68,0.28)",
    icon:  svgWarn(),
  },
};

function svgPause() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="3" height="8" rx="1" fill="#6b7280"/><rect x="7" y="2" width="3" height="8" rx="1" fill="#6b7280"/></svg>`;
}
function svgClock() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="#f5a623" stroke-width="1.4"/><path d="M6 3.5V6l2 1.2" stroke="#f5a623" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function svgPlay() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2.2l7 3.8-7 3.8V2.2z" fill="#34c77b"/></svg>`;
}
function svgWarn() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1L11.2 10H.8L6 1z" stroke="#ef4444" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 5v2.5M6 9v.5" stroke="#ef4444" stroke-width="1.3" stroke-linecap="round"/></svg>`;
}

function injectBadgeStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

    #${BADGE_ID} {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 0;
      border-radius: 10px;
      border: 1px solid rgba(55,65,81,0.7);
      background: rgba(17,19,24,0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      pointer-events: none;
      user-select: none;
      overflow: hidden;
      transition: border-color 0.3s ease, background 0.3s ease, box-shadow 0.3s ease,
                  opacity 0.35s ease, transform 0.35s cubic-bezier(.4,0,.2,1);
      opacity: 0;
      transform: translateY(8px) scale(0.97);
    }

    #${BADGE_ID}.sdb-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    #${BADGE_ID} .sdb-stripe {
      width: 3px;
      align-self: stretch;
      flex-shrink: 0;
      border-radius: 10px 0 0 10px;
      transition: background 0.3s ease;
    }

    #${BADGE_ID} .sdb-content {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px 8px 10px;
    }

    #${BADGE_ID} .sdb-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 16px;
      height: 16px;
    }

    #${BADGE_ID} .sdb-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    #${BADGE_ID} .sdb-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: #555d6b;
      line-height: 1;
    }

    #${BADGE_ID} .sdb-message {
      font-size: 12px;
      font-weight: 500;
      color: #e2e8f0;
      line-height: 1.2;
      white-space: nowrap;
      transition: color 0.25s ease;
    }

    #${BADGE_ID} .sdb-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4b5563;
      flex-shrink: 0;
      transition: background 0.3s ease, box-shadow 0.3s ease;
    }

    @keyframes sdb-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.45; }
    }

    #${BADGE_ID}.sdb-waiting .sdb-dot {
      animation: sdb-pulse 1.6s ease-in-out infinite;
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureBadge() {
  injectBadgeStyles();
  let badge = document.getElementById(BADGE_ID);
  if (badge) return badge;

  badge = document.createElement("div");
  badge.id = BADGE_ID;
  badge.innerHTML = `
    <div class="sdb-stripe"></div>
    <div class="sdb-content">
      <div class="sdb-icon"></div>
      <div class="sdb-text">
        <span class="sdb-title">Showdown Bot</span>
        <span class="sdb-message">Initialising…</span>
      </div>
      <div class="sdb-dot"></div>
    </div>
  `;

  document.documentElement.appendChild(badge);

  // Animate in after a short delay
  requestAnimationFrame(() => {
    requestAnimationFrame(() => badge.classList.add("sdb-visible"));
  });

  return badge;
}

let lastBadgeState = null;

function setBadge(text, stateKey) {
  if (text === lastBadgeState) return; // avoid needless DOM writes
  lastBadgeState = text;

  const badge   = ensureBadge();
  const state   = BADGE_STATES[stateKey] || BADGE_STATES.off;

  const stripe  = badge.querySelector(".sdb-stripe");
  const icon    = badge.querySelector(".sdb-icon");
  const message = badge.querySelector(".sdb-message");
  const dot     = badge.querySelector(".sdb-dot");

  // Apply state styles
  badge.style.borderColor  = state.border;
  badge.style.background   = state.bg;

  stripe.style.background  = state.dot;
  dot.style.background     = state.dot;
  dot.style.boxShadow      = stateKey !== "off"
    ? `0 0 5px ${state.dot}`
    : "none";

  message.style.color      = state.label;
  message.textContent      = text;
  icon.innerHTML           = state.icon;

  // Pulsing class for waiting state
  badge.classList.toggle("sdb-waiting", stateKey === "waiting");
}

// ---------------------------------------------------------------------
// Diagnostics: dump the likely controls area if we seem stuck
// ---------------------------------------------------------------------

function maybeLogDiagnostic() {
  const now = Date.now();
  if (now - lastFoundAnyAt < STUCK_THRESHOLD_MS) return;
  if (now - lastDiagnosticAt < STUCK_THRESHOLD_MS) return; // don't spam
  lastDiagnosticAt = now;

  const candidates = document.querySelectorAll(
    '.controls, .battle-controls, [class*="control"]'
  );
  if (candidates.length === 0) {
    log(
      "DIAGNOSTIC: no known button matched, and no '.controls'-like " +
        "container found either -- are you in an active battle right now?"
    );
    return;
  }
  const snippet = Array.from(candidates)
    .slice(0, 2)
    .map((el) => el.outerHTML.slice(0, 800))
    .join("\n---\n");
  log(
    "DIAGNOSTIC: enabled but no recognized move/switch/teampreview " +
      "button matched for 10+ seconds. Nearby controls markup:\n" + snippet
  );
}

// ---------------------------------------------------------------------
// Main decision loop
// ---------------------------------------------------------------------

function evaluateAndAct() {
  if (!enabled) {
    setBadge("Showdown Test Bot: OFF", "#888");
    return;
  }

  try {
    const move = queryFirstMatching(SELECTOR_SETS.move);
    const switches = queryFirstMatching(SELECTOR_SETS.switch);
    const teamPreview = queryFirstMatching(SELECTOR_SETS.teamPreview);

    const allButtons = [
      ...move.buttons,
      ...switches.buttons,
      ...teamPreview.buttons,
    ];

    if (allButtons.length === 0) {
      lastActedSignature = null;
      setBadge("Showdown Test Bot: ON — waiting for your turn", "#f0ad4e");
      maybeLogDiagnostic();
      return;
    }

    lastFoundAnyAt = Date.now();
    setBadge("Showdown Test Bot: ON — buttons found", "#5cb85c");

    const signature = signatureFor(allButtons);
    if (signature === lastActedSignature) {
      return; // already acted on this exact prompt
    }

    let chosen = null;
    let category = "";

    if (move.buttons.length > 0) {
      chosen = randomChoice(move.buttons);
      category = `move (via ${move.selectorUsed})`;
    } else if (switches.buttons.length > 0) {
      chosen = randomChoice(switches.buttons);
      category = `switch (via ${switches.selectorUsed})`;
    } else if (teamPreview.buttons.length > 0) {
      chosen = teamPreview.buttons[0];
      category = `teampreview (via ${teamPreview.selectorUsed})`;
    }

    if (!chosen) return;

    lastActedSignature = signature;
    const label = chosen.textContent.trim().replace(/\s+/g, " ");
    log(`Choosing ${category}: "${label}"`);

    const delay =
      ACTION_DELAY_MS[0] +
      Math.random() * (ACTION_DELAY_MS[1] - ACTION_DELAY_MS[0]);
    setTimeout(() => {
      try {
        chosen.click();
        setBadge(`Showdown Test Bot: clicked "${label}"`, "#5cb85c");
      } catch (err) {
        log(`ERROR clicking button: ${err.message}\n${err.stack}`);
        setBadge("Showdown Test Bot: click FAILED — see log", "#d9534f");
      }
    }, delay);
  } catch (err) {
    log(`ERROR in evaluateAndAct: ${err.message}\n${err.stack}`);
    setBadge("Showdown Test Bot: ERROR — see log", "#d9534f");
  }
}

// Two independent triggers, so a missed DOM event can't stall the bot silently.
// Mutation bursts are coalesced into one evaluateAndAct() call per tick, since
// Showdown's chat/animations can fire many mutations per second.
let scheduled = false;
function scheduleEvaluate() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    evaluateAndAct();
  });
}

const observer = new MutationObserver(() => scheduleEvaluate());
observer.observe(document.body, { childList: true, subtree: true });
setInterval(evaluateAndAct, 1000);

chrome.storage.local.get({ enabled: false }, (data) => {
  enabled = data.enabled;
  log(`Content script loaded. Enabled=${enabled}`);
  evaluateAndAct();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) {
    enabled = changes.enabled.newValue;
    log(`Toggled ${enabled ? "ON" : "OFF"}`);
    lastActedSignature = null;
    lastFoundAnyAt = Date.now();
    evaluateAndAct();
  }
});
