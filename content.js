/**
 * Showdown Battle Bot - content script (v2 — Intelligent Engine)
 *
 * Watches the page for Showdown's move/switch/teampreview buttons and
 * auto-clicks the BEST choice when it's your turn.
 *
 * Intelligence layers (in priority order):
 *   1. Type effectiveness vs opponent's active Pokémon
 *   2. Base power weighting
 *   3. Priority move bonus when opponent is low HP
 *   4. Spread move bonus in Doubles / FFA formats
 *   5. Status move penalty
 *   Fallback: random if Dex unavailable or all scores tied
 *
 * Robustness features:
 *   - Double-injection guard (safe to inject multiple times)
 *   - 3-tier + catch-all selector fallback
 *   - Lazy window.Dex loader with cache
 *   - In-memory battle memory (opponent types survive sub turns)
 *   - 60 ms computation budget guard
 *   - Format detector (Singles / Doubles / FFA)
 *   - Extension context invalidation guard + graceful teardown
 */

// ── DOUBLE-INJECTION GUARD ────────────────────────────────────────────────────
// The background service worker may inject this script again after a tab
// navigates. Bail out immediately if already running to avoid duplicate
// observers, intervals, and badge elements.
if (window.__sdbActive) {
  // Already initialised — nothing to do.
} else {
  window.__sdbActive = true;
  initBot();
}

function initBot() {

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SELECTOR_VERSION   = "2025-07-19";
const ACTION_DELAY_MS    = [300, 600]; // tighter range — less idle wait
const STUCK_THRESHOLD_MS = 10_000;
const SCORE_BUDGET_MS    = 40;         // abort scoring early on slow CPUs
const POLL_INTERVAL_MS   = 1500;       // 1.5 s — gentler than 1 s on weak hardware

// 3-tier + catch-all selector sets (primary → fallbacks)
// Tier 0: official Showdown name= attribute (most reliable)
// Tier 1: class-based (older markup)
// Tier 2: data-attribute (newer Preact markup)
// Tier 3: broad class catch-all (last resort)
const SELECTOR_TIERS = {
  move: [
    'button[name="chooseMove"]:not([disabled]):not(.disabled)',
    '.movemenu button:not(.disabled):not([disabled])',
    'button[data-move]:not([disabled]):not(.disabled)',
    '.battle-controls .controls button:not([disabled]):not(.disabled):not([name="chooseSwitch"]):not([name="chooseTeamPreview"])',
  ],
  switch: [
    'button[name="chooseSwitch"]:not([disabled]):not(.disabled)',
    '.switchmenu button:not(.disabled):not([disabled])',
    'button[data-switch]:not([disabled]):not(.disabled)',
  ],
  teamPreview: [
    'button[name="chooseTeamPreview"]:not([disabled]):not(.disabled)',
    '.teampreview button:not([disabled]):not(.disabled)',
  ],
};

// Miss-count arrays — length must match tier count above
const selectorHealth = { move: [0, 0, 0, 0], switch: [0, 0, 0] };

// ─────────────────────────────────────────────────────────────────────────────
// GEN 9 TYPE CHART  (attacker → defender → multiplier)
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_CHART = {
  Normal:   { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire:     { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water:    { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass:    { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice:      { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison:   { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground:   { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying:   { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic:  { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug:      { Fire: 0.5, Grass: 2, Fighting: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock:     { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost:    { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon:   { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark:     { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel:    { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy:    { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT GUARD
// ─────────────────────────────────────────────────────────────────────────────

function ctxAlive() {
  try { return !!chrome.runtime?.id; }
  catch (_) { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

function log(message) {
  const entry = { time: new Date().toISOString(), message };
  console.log("[ShowdownBot]", message);
  if (!ctxAlive()) return;
  try {
    chrome.storage.local.get({ bugLog: [] }, (data) => {
      if (!ctxAlive()) return;
      const bugLog = data.bugLog;
      bugLog.push(entry);
      while (bugLog.length > 500) bugLog.shift();
      chrome.storage.local.set({ bugLog });
    });
  } catch (_) { /* context gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTOR ENGINE — 3-tier with self-healing
// ─────────────────────────────────────────────────────────────────────────────

function queryTiered(type) {
  const tiers = SELECTOR_TIERS[type];
  if (!tiers) return { buttons: [], selectorUsed: null, tier: -1 };

  for (let t = 0; t < tiers.length; t++) {
    const found = Array.from(document.querySelectorAll(tiers[t]));
    if (found.length > 0) {
      // Reset miss counter for this tier; increment others
      if (selectorHealth[type]) {
        selectorHealth[type] = selectorHealth[type].map((v, i) => i === t ? 0 : v + 1);
      }
      return { buttons: found, selectorUsed: tiers[t], tier: t };
    }
  }

  if (selectorHealth[type]) {
    selectorHealth[type] = selectorHealth[type].map(v => v + 1);
  }
  return { buttons: [], selectorUsed: null, tier: -1 };
}

// Selector watchdog — logs health every 10 minutes
setInterval(() => {
  log(`SelectorHealth v${SELECTOR_VERSION}: ${JSON.stringify(selectorHealth)}`);
}, 600_000);

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW.DEX — lazy loader with cache
// ─────────────────────────────────────────────────────────────────────────────

let _dexCache = null;

function getDex() {
  if (_dexCache) return _dexCache;
  // FIX: explicit checks instead of chained ?? to avoid operator-precedence
  // bug where (a??b??c)?window:null always resolved dex=window when a was truthy.
  const candidates = [
    window.Dex,
    window.app && window.app.dex,
    window.BattleMovedex,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.moves === "object" &&
        typeof candidate.moves.get === "function") {
      _dexCache = candidate;
      return _dexCache;
    }
  }
  return null;
}

function getMoveData(moveName) {
  try {
    const dex = getDex();
    if (!dex) return null;
    const m = dex.moves.get(moveName);
    if (!m || !m.id) return null;
    return {
      name:      m.name  || moveName,
      type:      m.type  || "Normal",
      basePower: m.basePower || 0,
      category:  m.category || "Status",
      priority:  m.priority || 0,
      target:    m.target   || "normal",
    };
  } catch (_) { return null; }
}

function getSpeciesTypes(speciesName) {
  try {
    const dex = getDex();
    if (!dex) return null;
    const sp = dex.species.get(speciesName);
    if (!sp || !sp.types) return null;
    return sp.types; // e.g. ["Fire", "Flying"]
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// BATTLE MEMORY — accumulates revealed opponent info across turns
// ─────────────────────────────────────────────────────────────────────────────

const battleMemory = {
  opponentSeen: {},  // { "Charizard": { types: ["Fire","Flying"] } }

  recordOpponent(name, types) {
    if (name && types && !this.opponentSeen[name]) {
      this.opponentSeen[name] = { types };
      log(`Memory: recorded ${name} as ${types.join("/")}`);
    }
  },

  getTypes(name) {
    return name ? (this.opponentSeen[name]?.types ?? null) : null;
  },

  reset() {
    this.opponentSeen = {};
    log("Memory: reset (new battle or toggle)");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function detectFormat() {
  const url = location.href + (document.title || "");
  if (/freeforall|4player|multipl/i.test(url)) return "ffa";
  if (/doubles|vgc|2v2|partnersincrime/i.test(url)) return "doubles";
  return "singles";
}

// ─────────────────────────────────────────────────────────────────────────────
// BATTLE STATE READER
// ─────────────────────────────────────────────────────────────────────────────

// DOM-only opponent detection — no window.app access to avoid interfering
// with Showdown's internal JS objects (which caused page crashes).
function readOpponentName() {
  const selectors = [
    ".statbar.lstatbar .name",
    ".statbar.lstatbar strong",
    ".battle .statbar:not(.rstatbar) .name",
    ".rqpoke strong",
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      const name = el && el.textContent.trim();
      if (name && name.length > 1) return name;
    } catch (_) {}
  }
  return null;
}

function readOpponentHpPct() {
  try {
    // Read the HP bar width rendered by Showdown (safest approach)
    const bar = document.querySelector(
      ".statbar.lstatbar .hpbar > div, " +
      ".battle .statbar:not(.rstatbar) .hpbar > div"
    );
    if (bar) {
      const w = parseFloat(bar.style.width);
      if (!isNaN(w) && w >= 0) return w / 100;
    }
  } catch (_) {}
  return 1; // assume full HP if unreadable
}

function readBattleState() {
  const oppName  = readOpponentName();
  const oppHpPct = readOpponentHpPct();
  const format   = detectFormat();

  // Try to get types from memory first, then Dex, then null
  let oppTypes = battleMemory.getTypes(oppName);
  if (!oppTypes && oppName) {
    oppTypes = getSpeciesTypes(oppName);
    if (oppTypes) battleMemory.recordOpponent(oppName, oppTypes);
  }

  return { oppName, oppTypes, oppHpPct, format };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function calcTypeEffectiveness(moveType, defenderTypes) {
  if (!defenderTypes || defenderTypes.length === 0) return 1;
  const chart = TYPE_CHART[moveType] || {};
  return defenderTypes.reduce((acc, dt) => {
    const mult = chart[dt];
    return acc * (mult !== undefined ? mult : 1);
  }, 1);
}

function scoreMove(moveData, state) {
  if (!moveData) return 0; // unknown move → neutral

  let score = 0;

  // 1. Type effectiveness
  if (state.oppTypes) {
    const eff = calcTypeEffectiveness(moveData.type, state.oppTypes);
    if (eff === 0)    return -999; // immune — never pick
    if (eff >= 4)     score += 80;
    else if (eff >= 2) score += 40;
    else if (eff <= 0.25) score -= 50;
    else if (eff <= 0.5)  score -= 25;
    // neutral → 0
  }

  // 2. Base power
  if (moveData.basePower > 0) {
    score += Math.floor(moveData.basePower / 3);
  } else {
    score -= 10; // status move penalty
  }

  // 3. Priority bonus — finish off low-HP opponents
  if (moveData.priority > 0 && state.oppHpPct < 0.30) {
    score += 50;
  }

  // 4. Spread / multi-target bonus for Doubles / FFA
  if (state.format !== "singles") {
    const spreadTargets = ["allAdjacentFoes", "allAdjacent", "foeSide", "allSides"];
    if (spreadTargets.includes(moveData.target)) {
      score += state.format === "ffa" ? 30 : 20;
    }
  }

  return score;
}

function getMoveNameFromButton(btn) {
  // Try data-move attribute first, then text content
  const dm = btn.dataset?.move;
  if (dm) return dm;
  // Button text often contains move name
  return btn.textContent?.trim().split("\n")[0].trim() || null;
}

function scoreMoves(buttons, state) {
  const start = performance.now();
  const scored = [];

  for (const btn of buttons) {
    // Budget guard — if computation is expensive, score remainder as 0
    if (performance.now() - start > SCORE_BUDGET_MS) {
      scored.push({ btn, score: 0, name: "?" });
      continue;
    }
    const moveName = getMoveNameFromButton(btn);
    const moveData = moveName ? getMoveData(moveName) : null;
    const score    = scoreMove(moveData, state);
    scored.push({ btn, score, name: moveName ?? "?", moveData });
  }

  return scored;
}

function chooseBestMove(buttons, state) {
  const scored = scoreMoves(buttons, state);

  // Defer the log string build — never block the click on slow CPUs
  setTimeout(() => {
    const summary = scored.map(s => `${s.name}(${s.score})`).join(", ");
    log(`Scoring: [${summary}] opp=${state.oppName ?? "?"} ${(state.oppTypes ?? []).join("/")} hp=${Math.round((state.oppHpPct ?? 1) * 100)}%`);
  }, 0);

  // Sort descending; filter out immune (-999) if alternatives exist
  const valid = scored.filter(s => s.score > -999);
  const pool  = valid.length > 0 ? valid : scored; // all immune? pick anyway

  pool.sort((a, b) => b.score - a.score);

  // Among top-scoring moves, pick randomly to avoid being predictable
  const best  = pool[0].score;
  const tied  = pool.filter(s => s.score === best);
  return tied[Math.floor(Math.random() * tied.length)].btn;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Cheap signature using textContent which includes PP counts ("31/32", "8/8").
// PP changes each time a move is used, so the signature naturally differs
// across turns even for the same Pokémon with the same moves.
// IMPORTANT: do NOT use b.value as primary key — Showdown sets value to the
// slot index ("1","2","3","4") which is identical every single turn.
function signatureFor(buttons) {
  return buttons.map(b =>
    b.textContent.trim().replace(/\s+/g, " ").slice(0, 40) ||
    b.dataset.move || b.dataset.switch ||
    b.name + ":" + (b.value || "?")
  ).join("|");
}

// Handle multi-target selection in Doubles/FFA after a move is clicked
function clickTargetIfNeeded() {
  setTimeout(() => {
    const targetBtn = document.querySelector(
      'button[name="chooseTarget"]:not([disabled]), .battle-controls button.has-tooltip[data-target]:not([disabled])'
    );
    if (targetBtn) {
      log("Multi-target detected — clicking first available target");
      targetBtn.click();
    }
  }, 300);
}

// ─────────────────────────────────────────────────────────────────────────────
// ON-PAGE BADGE (professional, low-profile)
// ─────────────────────────────────────────────────────────────────────────────

const BADGE_ID = "sdb-notifier";
const STYLE_ID = "sdb-notifier-style";

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

const BADGE_STATES = {
  off:     { dot: "#4b5563", label: "#9ca3af", bg: "rgba(17,19,24,0.92)", border: "rgba(55,65,81,0.7)",      icon: svgPause() },
  waiting: { dot: "#f5a623", label: "#f5a623", bg: "rgba(17,19,24,0.94)", border: "rgba(245,166,35,0.25)",   icon: svgClock() },
  active:  { dot: "#34c77b", label: "#e2e8f0", bg: "rgba(17,19,24,0.94)", border: "rgba(52,199,123,0.28)",   icon: svgPlay()  },
  error:   { dot: "#ef4444", label: "#fca5a5", bg: "rgba(17,19,24,0.94)", border: "rgba(239,68,68,0.28)",    icon: svgWarn()  },
};

function injectBadgeStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BADGE_ID} {
      position: fixed; bottom: 12px; right: 12px; z-index: 2147483647;
      display: flex; align-items: center; gap: 0;
      border-radius: 8px; border: 1px solid rgba(55,65,81,0.5);
      background: rgba(17,19,24,0.82);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      pointer-events: none; user-select: none; overflow: hidden;
      transition: border-color 0.3s ease, background 0.3s ease,
                  opacity 0.4s ease, transform 0.35s cubic-bezier(.4,0,.2,1);
      opacity: 0; transform: translateY(6px);
    }
    #${BADGE_ID}.sdb-visible { opacity: 0.45; transform: translateY(0); }
    #${BADGE_ID}.sdb-visible:hover { opacity: 0.85; }
    #${BADGE_ID} .sdb-stripe { width: 2px; align-self: stretch; flex-shrink: 0; border-radius: 8px 0 0 8px; transition: background 0.3s ease; }
    #${BADGE_ID} .sdb-content { display: flex; align-items: center; gap: 6px; padding: 5px 9px 5px 7px; }
    #${BADGE_ID} .sdb-icon { display: none; }
    #${BADGE_ID} .sdb-text { display: flex; flex-direction: column; }
    #${BADGE_ID} .sdb-title { display: none; }
    #${BADGE_ID} .sdb-message { font-size: 10.5px; font-weight: 500; color: #cbd5e1; line-height: 1; white-space: nowrap; transition: color 0.25s ease; }
    #${BADGE_ID} .sdb-dot { width: 5px; height: 5px; border-radius: 50%; background: #4b5563; flex-shrink: 0; transition: background 0.3s ease, box-shadow 0.3s ease; }
    @keyframes sdb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    #${BADGE_ID}.sdb-waiting .sdb-dot { animation: sdb-pulse 1.8s ease-in-out infinite; }
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
  requestAnimationFrame(() => requestAnimationFrame(() => badge.classList.add("sdb-visible")));
  return badge;
}

let lastBadgeState = null;

function setBadge(text, stateKey) {
  if (text === lastBadgeState) return;
  lastBadgeState = text;
  const badge   = ensureBadge();
  const state   = BADGE_STATES[stateKey] || BADGE_STATES.off;
  const stripe  = badge.querySelector(".sdb-stripe");
  const icon    = badge.querySelector(".sdb-icon");
  const message = badge.querySelector(".sdb-message");
  const dot     = badge.querySelector(".sdb-dot");
  badge.style.borderColor = state.border;
  badge.style.background  = state.bg;
  stripe.style.background = state.dot;
  dot.style.background    = state.dot;
  dot.style.boxShadow     = stateKey !== "off" ? `0 0 5px ${state.dot}` : "none";
  message.style.color     = state.label;
  message.textContent     = text;
  icon.innerHTML          = state.icon;
  badge.classList.toggle("sdb-waiting", stateKey === "waiting");
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────

let lastFoundAnyAt  = Date.now();
let lastDiagnosticAt = 0;

function maybeLogDiagnostic() {
  const now = Date.now();
  if (now - lastFoundAnyAt   < STUCK_THRESHOLD_MS) return;
  if (now - lastDiagnosticAt < STUCK_THRESHOLD_MS) return;
  lastDiagnosticAt = now;

  const candidates = document.querySelectorAll('.controls, .battle-controls, [class*="control"]');
  if (candidates.length === 0) {
    log("DIAGNOSTIC: no controls found — are you in an active battle?");
    return;
  }
  const snippet = Array.from(candidates)
    .slice(0, 2)
    .map(el => el.outerHTML.slice(0, 800))
    .join("\n---\n");
  log(`DIAGNOSTIC: stuck 10s+. Controls markup:\n${snippet}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

let enabled            = false;
let lastActedSignature = null;
let lastActedAt        = 0;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DECISION LOOP
// ─────────────────────────────────────────────────────────────────────────────

function evaluateAndAct() {
  if (!enabled) {
    setBadge("Bot is disabled", "off");
    return;
  }

  try {
    const move        = queryTiered("move");
    const switches    = queryTiered("switch");
    const teamPreview = queryTiered("teamPreview");

    const allButtons = [
      ...move.buttons,
      ...switches.buttons,
      ...teamPreview.buttons,
    ];

    if (allButtons.length === 0) {
      lastActedSignature = null;
      setBadge("Waiting for your turn", "waiting");
      maybeLogDiagnostic();
      return;
    }

    lastFoundAnyAt = Date.now();
    setBadge("Analysing…", "active");

    const signature = signatureFor(allButtons);
    if (signature === lastActedSignature) {
      if (Date.now() - lastActedAt > 3000) {
        log("Turn didn't advance after 3s. Retrying...");
        lastActedSignature = null;
      } else {
        return; // already acted this turn, waiting for server
      }
    }

    let chosen   = null;
    let category = "";

    if (move.buttons.length > 0) {
      // ── INTELLIGENT move selection ──
      const state = readBattleState();
      const dex   = getDex();

      if (dex) {
        chosen = chooseBestMove(move.buttons, state);
      } else {
        log("Dex unavailable — falling back to random");
        chosen = randomChoice(move.buttons);
      }
      category = `move(t${move.tier})`;

    } else if (switches.buttons.length > 0) {
      // Filter out fainted Pokemon (Showdown sometimes leaves them clickable but throws an alert)
      const validSwitches = switches.buttons.filter(b => {
        const text = b.textContent.toLowerCase();
        return !text.includes('fainted') && !text.includes('0%') && !b.classList.contains('disabled');
      });

      if (validSwitches.length > 0) {
        chosen   = randomChoice(validSwitches);
        category = `switch(t${switches.tier})`;
      } else {
        log("No valid switch options available");
        lastActedSignature = null;
        return;
      }
    } else if (teamPreview.buttons.length > 0) {
      chosen   = teamPreview.buttons[0];
      category = "teampreview";
    }

    if (!chosen) return;

    lastActedSignature = signature;
    lastActedAt        = Date.now();
    const label = chosen.textContent.trim().replace(/\s+/g, " ");
    log(`Choosing ${category}: "${label}"`);

    const delay = ACTION_DELAY_MS[0] + Math.random() * (ACTION_DELAY_MS[1] - ACTION_DELAY_MS[0]);
    setTimeout(() => {
      try {
        // Guard: button may have disappeared during delay
        if (!document.contains(chosen)) {
          lastActedSignature = null;
          log("Button gone before click — will re-evaluate");
          return;
        }
        chosen.click();
        setBadge(`▶ ${label}`, "active");

        // Handle multi-target prompts in Doubles/FFA
        if (detectFormat() !== "singles") clickTargetIfNeeded();

      } catch (err) {
        log(`ERROR clicking button: ${err.message}\n${err.stack}`);
        setBadge("Click failed — see log", "error");
      }
    }, delay);

  } catch (err) {
    log(`ERROR in evaluateAndAct: ${err.message}\n${err.stack}`);
    setBadge("Unexpected error — see log", "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGERS — MutationObserver + 1s poll
// ─────────────────────────────────────────────────────────────────────────────

// 50ms debounce: collapses rapid DOM bursts (Showdown fires hundreds of
// mutations/sec) without being slow enough to miss turn windows.
let _debounceTimer = null;
function scheduleEvaluate() {
  if (_debounceTimer !== null) return;
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    evaluateAndAct();
  }, 50);
}

// Only watch structural changes — excludes attribute/text mutations which
// are very frequent during Showdown's battle animations.
const observer = new MutationObserver(() => scheduleEvaluate());
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: false,
  characterData: false,
});

const pollInterval = setInterval(() => {
  if (!ctxAlive()) { teardown(); return; }
  evaluateAndAct();
}, POLL_INTERVAL_MS);

// ─────────────────────────────────────────────────────────────────────────────
// TEARDOWN — graceful shutdown on extension reload/update
// ─────────────────────────────────────────────────────────────────────────────

function teardown() {
  observer.disconnect();
  clearInterval(pollInterval);
  if (_debounceTimer !== null) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  const badge = document.getElementById(BADGE_ID);
  if (badge) badge.style.opacity = "0";
  battleMemory.reset();
}

try {
  const port = chrome.runtime.connect({ name: "keepalive" });
  port.onDisconnect.addListener(teardown);
} catch (_) { /* already invalidated */ }

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

if (!ctxAlive()) {
  teardown();
} else {
  chrome.storage.local.get({ enabled: false }, (data) => {
    if (!ctxAlive()) return;
    enabled = data.enabled;
    log(`Bot loaded. Enabled=${enabled} | Format=${detectFormat()} | Dex=${!!getDex()}`);
    evaluateAndAct();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!ctxAlive()) return;
    if (area === "local" && changes.enabled) {
      enabled = changes.enabled.newValue;
      log(`Toggled ${enabled ? "ON" : "OFF"}`);
      lastActedSignature = null;
      lastFoundAnyAt     = Date.now();
      if (!enabled) battleMemory.reset();
      evaluateAndAct();
    }
  });
}

} // end initBot()
