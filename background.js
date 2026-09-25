"use strict";

importScripts("core.js");

const HISTORY_KEY = "answerHistory";
const HISTORY_LIMIT = 200;
const HISTORY_MESSAGES = new Set(["HISTORY_ADD", "HISTORY_LIST", "HISTORY_CLEAR"]);
let historyQueue = Promise.resolve();

function validateSelection(selection, sender) {
  if (!selection || !IClickerMajority.id(selection.courseId) ||
      !IClickerMajority.id(selection.activityId) || !IClickerMajority.id(selection.questionId) ||
      typeof selection.questionName !== "string" || !selection.questionName.trim() ||
      selection.questionName.length > 200 || !/^[A-E]$/.test(selection.answer) ||
      !["random", "live"].includes(selection.source)) {
    throw new Error("The answer-history entry is invalid.");
  }
  if (!sender.tab || !sender.url ||
      IClickerMajority.courseFromUrl(sender.url) !== selection.courseId) {
    throw new Error("Selections can only be recorded from the matching iClicker poll.");
  }
  if (selection.source === "live" &&
      (typeof selection.percentage !== "number" || !Number.isFinite(selection.percentage) ||
       selection.percentage <= 0 || selection.percentage > 100)) {
    throw new Error("The live-vote percentage is invalid.");
  }
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    courseId: selection.courseId,
    activityId: selection.activityId,
    questionId: selection.questionId,
    questionName: selection.questionName.trim(),
    answer: selection.answer,
    source: selection.source,
    percentage: selection.source === "live" ? selection.percentage : null
  };
}

async function handleHistory(message, sender) {
  if (message.type === "HISTORY_CLEAR") {
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
    return { entries: [] };
  }
  const selection = message.type === "HISTORY_ADD"
    ? validateSelection(message.selection, sender)
    : null;
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const entries = stored[HISTORY_KEY] === undefined ? [] : stored[HISTORY_KEY];
  if (!Array.isArray(entries)) {
    throw new Error("Saved answer history is unreadable. Use Clear history to reset it.");
  }
  if (!selection) return { entries };
  const updated = [selection, ...entries].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [HISTORY_KEY]: updated });
  return { id: selection.id };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !HISTORY_MESSAGES.has(message?.type)) return;
  // Serialize read-modify-write operations so different tabs cannot lose entries.
  const operation = historyQueue.then(() => handleHistory(message, sender));
  historyQueue = operation.then(() => undefined, () => undefined);
  operation.then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message || "Answer history could not be saved." })
  );
  return true;
});
