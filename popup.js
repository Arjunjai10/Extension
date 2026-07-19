const toggle = document.getElementById("enabledToggle");
const toggleCard = document.getElementById("toggleCard");
const toggleState = document.getElementById("toggleState");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const status = document.getElementById("status");

function updateToggleUI(enabled) {
  if (enabled) {
    toggleCard.classList.add("active");
    toggleState.textContent = "ENABLED";
  } else {
    toggleCard.classList.remove("active");
    toggleState.textContent = "DISABLED";
  }
}

function updateStatus(count) {
  if (count === 0) {
    status.innerHTML = "No log entries stored.";
  } else {
    status.innerHTML = `<span>${count}</span> log entr${count === 1 ? "y" : "ies"} stored.`;
  }
}

chrome.storage.local.get({ enabled: false, bugLog: [] }, (data) => {
  toggle.checked = data.enabled;
  updateToggleUI(data.enabled);
  updateStatus(data.bugLog.length);
});

// Clicking anywhere on the card toggles auto-play
toggleCard.addEventListener("click", () => {
  toggle.checked = !toggle.checked;
  chrome.storage.local.set({ enabled: toggle.checked });
  updateToggleUI(toggle.checked);
});

exportBtn.addEventListener("click", () => {
  chrome.storage.local.get({ bugLog: [] }, (data) => {
    const text = data.bugLog
      .map((e) => `[${e.time}] ${e.message}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    // Opens the log in a new tab; use Ctrl+S / Cmd+S there to save it as a file.
    window.open(url, "_blank");
  });
});

clearBtn.addEventListener("click", () => {
  chrome.storage.local.set({ bugLog: [] }, () => {
    updateStatus(0);
  });
});
