const toggle     = document.getElementById("enabledToggle");
const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const logCount   = document.getElementById("logCount");
const exportBtn  = document.getElementById("exportBtn");
const clearBtn   = document.getElementById("clearBtn");

function updateStatusUI(enabled) {
  if (enabled) {
    statusPill.classList.add("active");
    statusText.textContent = "Active — monitoring battles";
  } else {
    statusPill.classList.remove("active");
    statusText.textContent = "Inactive";
  }
}

function updateLogCount(count) {
  logCount.textContent = count.toLocaleString();
}

// Load initial state
chrome.storage.local.get({ enabled: false, bugLog: [] }, (data) => {
  toggle.checked = data.enabled;
  updateStatusUI(data.enabled);
  updateLogCount(data.bugLog.length);
});

// Toggle handler
toggle.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: toggle.checked });
  updateStatusUI(toggle.checked);
});

// Export log
exportBtn.addEventListener("click", () => {
  chrome.storage.local.get({ bugLog: [] }, (data) => {
    const text = data.bugLog
      .map((e) => `[${e.time}] ${e.message}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    // Opens log in a new tab — use Ctrl+S / Cmd+S there to save it.
    window.open(url, "_blank");
  });
});

// Clear log
clearBtn.addEventListener("click", () => {
  chrome.storage.local.set({ bugLog: [] }, () => {
    updateLogCount(0);
  });
});
