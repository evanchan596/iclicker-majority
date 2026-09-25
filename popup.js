"use strict";

const toggle = document.getElementById("toggle");
const randomFallback = document.getElementById("random-fallback");
const message = document.getElementById("message");
const state = document.getElementById("state");
const question = document.getElementById("question");
const votes = document.getElementById("votes");
const historyList = document.getElementById("history-list");
const historySummary = document.getElementById("history-summary");
const historyError = document.getElementById("history-error");
const clearHistory = document.getElementById("clear-history");
let tabId;
let enabled = false;
let busy = false;
let refreshTimer;
let commandVersion = 0;
let historyVersion = 0;

function renderHistory(entries) {
  const randomCount = entries.filter((entry) => entry.source === "random").length;
  historySummary.textContent = entries.length
    ? `${randomCount} random / ${entries.length - randomCount} live-vote selections`
    : "No automatic selections recorded yet.";
  historyList.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "history-item";
    const top = document.createElement("div");
    top.className = "history-item-top";
    const title = document.createElement("strong");
    title.textContent = `${entry.questionName}: ${entry.answer}`;
    const source = document.createElement("span");
    source.className = "source-badge";
    source.dataset.source = entry.source;
    source.textContent = entry.source === "random" ? "Random" : "Live votes";
    top.append(title, source);
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const time = document.createElement("time");
    time.dateTime = entry.timestamp;
    time.textContent = new Date(entry.timestamp).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
    const details = document.createElement("span");
    details.textContent = `Course ${entry.courseId.slice(-6)}` +
      (entry.source === "live" ? ` / ${entry.percentage}%` : "");
    details.title = `Course: ${entry.courseId}\nActivity: ${entry.activityId}\nQuestion: ${entry.questionId}`;
    meta.append(time, details);
    item.append(top, meta);
    historyList.append(item);
  }
  clearHistory.disabled = entries.length === 0;
}

async function historyCommand(type = "HISTORY_LIST") {
  const version = ++historyVersion;
  clearHistory.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok || !Array.isArray(response.entries)) {
      throw new Error(response?.error || "The history service did not respond.");
    }
    if (version !== historyVersion) return;
    renderHistory(response.entries);
    historyError.hidden = true;
  } catch (error) {
    if (version !== historyVersion) return;
    historyError.textContent = `Could not load or update history: ${error.message}`;
    historyError.hidden = false;
    historySummary.textContent = "History unavailable.";
    clearHistory.disabled = false;
  }
}

clearHistory.addEventListener("click", () => historyCommand("HISTORY_CLEAR"));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.answerHistory) historyCommand();
});

function render(status) {
  enabled = status.enabled;
  toggle.textContent = enabled ? "Pause auto-select" : "Start auto-select";
  toggle.disabled = busy;
  randomFallback.checked = status.randomFallback === true;
  randomFallback.disabled = busy;
  state.textContent = enabled ? "Running" : status.kind === "error" ? "Stopped" : "Paused";
  state.dataset.kind = status.kind;
  message.textContent = status.message;
  question.hidden = !status.question;
  question.textContent = status.question || "";
  votes.replaceChildren();
  for (const row of [...(status.rows || [])].sort((a, b) => a.answer.localeCompare(b.answer))) {
    const container = document.createElement("div");
    container.className = "vote";
    const label = document.createElement("span");
    label.textContent = row.answer;
    const bar = document.createElement("progress");
    bar.max = 100;
    bar.value = row.percentage;
    bar.setAttribute("aria-label", `Answer ${row.answer}: ${row.percentage}%`);
    const percentage = document.createElement("span");
    percentage.textContent = `${row.percentage}%`;
    container.append(label, bar, percentage);
    votes.append(container);
  }
}

function fail(text) {
  clearTimeout(refreshTimer);
  toggle.disabled = true;
  randomFallback.disabled = true;
  state.textContent = "Not connected";
  state.dataset.kind = "error";
  message.textContent = text;
  votes.replaceChildren();
  question.hidden = true;
}

async function refresh() {
  if (busy) {
    refreshTimer = setTimeout(refresh, 1000);
    return;
  }
  const version = commandVersion;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "MAJORITY_STATUS" });
    if (!busy && version === commandVersion) render(result);
    refreshTimer = setTimeout(refresh, 1000);
  } catch (error) {
    if (version === commandVersion) {
      fail("Refresh the iClicker tab after installing or updating this extension, then reopen this popup.");
    } else {
      refreshTimer = setTimeout(refresh, 1000);
    }
  }
}

async function command(payload) {
  busy = true;
  commandVersion += 1;
  toggle.disabled = true;
  randomFallback.disabled = true;
  try {
    const result = await chrome.tabs.sendMessage(tabId, payload);
    busy = false;
    render(result);
  } catch (error) {
    busy = false;
    fail("Could not reach the iClicker tab. Refresh it and reopen this popup.");
  }
}

toggle.addEventListener("click", () => {
  command({ type: enabled ? "MAJORITY_STOP" : "MAJORITY_START" });
});

randomFallback.addEventListener("change", () => {
  command({ type: "MAJORITY_OPTIONS", randomFallback: randomFallback.checked });
});

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== "https://student.iclicker.com") {
      fail("Open student.iclicker.com, sign in, and open this extension from that tab.");
      return;
    }
    tabId = tab.id;
    await refresh();
  } catch (error) {
    fail("Chrome could not connect to this tab. Reopen the extension on iClicker.");
  }
}

historyCommand();
init();
