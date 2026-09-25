(() => {
  "use strict";

  if (globalThis.__iclickerMajorityLoaded) return;
  globalThis.__iclickerMajorityLoaded = true;
  const Core = globalThis.IClickerMajority;
  const API = "https://api.iclicker.com";
  const INTERVAL = 5000;
  const REPORT_RETRY = 15000;
  const stability = new Core.Stability();
  const randomAnswers = new Map();
  const unavailableReports = new Map();
  let enabled = false;
  let randomFallback = false;
  let timer = null;
  let pending = null;
  let generation = 0;
  let running = false;
  let route = location.href;
  let lastAttempt = null;
  let liveResults = null;
  let status = { enabled, randomFallback, liveResults, kind: "off", message: "Paused. Nothing will be selected.", rows: [] };

  class RequestError extends Error {
    constructor(message, permanent = false, retryAfter = INTERVAL, httpStatus = null) {
      super(message);
      this.permanent = permanent;
      this.retryAfter = retryAfter;
      this.httpStatus = httpStatus;
    }
  }

  class HistoryError extends Error {}

  async function recordSelection(selection) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "HISTORY_ADD", selection });
      if (!response?.ok) throw new Error(response?.error || "The history service did not respond.");
    } catch (error) {
      throw new HistoryError(`The answer was clicked, but its history could not be saved. Paused. ${error.message}`);
    }
  }

  function publish(kind, message, extra = {}) {
    status = { enabled, randomFallback, liveResults, kind, message, rows: [], ...extra };
  }

  function getView() {
    const roots = [...document.querySelectorAll("app-poll app-multiple-choice-question")]
      .filter((element) => element.getClientRects().length > 0);
    if (roots.length !== 1) return null;
    const root = roots[0];
    const buttons = new Map();
    for (const button of root.querySelectorAll(".multiple-choice-buttons .btn-container button")) {
      const answer = button.textContent.trim().toUpperCase();
      if (!/^[A-E]$/.test(answer) || buttons.has(answer)) return null;
      if (button.getClientRects().length) buttons.set(answer, button);
    }
    if (buttons.size < 2 || root.querySelector(".connection-error")) return null;
    const poll = root.closest("app-poll");
    const heading = poll.querySelector("app-primary-header")?.textContent.replace(/\s+/g, " ").trim() || "";
    const images = [...root.querySelectorAll(".question-image-container img")].map((image) => image.src);
    return {
      root,
      buttons,
      heading,
      fingerprint: JSON.stringify([heading, images, [...buttons.keys()]])
    };
  }

  function sameView(before) {
    const after = getView();
    return after && after.root === before.root && after.fingerprint === before.fingerprint &&
      [...before.buttons].every(([answer, button]) => after.buttons.get(answer) === button);
  }

  function isSelected(button) {
    return button.classList.contains("btn-selected") || button.getAttribute("aria-pressed") === "true";
  }

  function isEnabled(button) {
    return !button.disabled && button.getAttribute("aria-disabled") !== "true";
  }

  async function getJson(path, signal) {
    const token = sessionStorage.getItem("access_token");
    if (!token) throw new RequestError("Sign in to iClicker, then start again.", true);
    let response;
    try {
      response = await fetch(`${API}${path}`, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Reef-Auth-Type": "oauth"
        },
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RequestError("The iClicker API could not be reached (network or CORS). No answer was selected.", false, 15000);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RequestError(
        response.status === 401
          ? "Your iClicker session expired. Sign in again, then restart."
          : "iClicker denied access to these results. Stopped; access restrictions will not be bypassed.",
        true, INTERVAL, response.status
      );
    }
    if (response.status === 404) {
      throw new RequestError("Live results or the required student API are unavailable. Stopped.",
        true, INTERVAL, response.status);
    }
    if (response.status === 429) {
      const value = response.headers.get("Retry-After");
      const seconds = value && /^\d+$/.test(value) ? Number(value) : null;
      const until = value ? Date.parse(value) : NaN;
      const wait = seconds !== null ? seconds * 1000 : Number.isFinite(until) ? until - Date.now() : 60000;
      throw new RequestError("iClicker requested a pause. Waiting before retrying.",
        false, Math.max(60000, wait), response.status);
    }
    if (!response.ok) {
      throw new RequestError(`iClicker returned HTTP ${response.status}. No answer was selected.`,
        response.status < 500, 15000, response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Core.DataError("iClicker returned an unreadable response. Stopped.");
    }
  }

  function resetWork(preserveAttempt = false) {
    generation += 1;
    clearTimeout(timer);
    pending?.abort();
    stability.reset();
    liveResults = null;
    if (!preserveAttempt) lastAttempt = null;
  }

  function schedule(delay = INTERVAL) {
    clearTimeout(timer);
    if (enabled) timer = setTimeout(tick, delay);
  }

  async function tick() {
    if (!enabled || running) return;
    running = true;
    const epoch = generation;
    const url = location.href;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    let delay = INTERVAL;
    const current = () => enabled && epoch === generation && location.href === url;
    try {
      const courseId = Core.courseFromUrl(url);
      if (!courseId) {
        stability.reset();
        liveResults = null;
        publish("waiting", "Join your class and open a live single-answer poll.");
        return;
      }
      const view = getView();
      if (!view) {
        stability.reset();
        liveResults = null;
        publish("waiting", "Waiting for a connected A-E single-answer poll. Quizzes and group polls are not supported.");
        return;
      }
      const query = "?recordsPerPage=1&pageNumber=1&expandChild=activities&expandChild=questions";
      const sections = await getJson(`/v2/courses/${courseId}/class-sections${query}`, controller.signal);
      if (!current() || !sameView(view)) return;
      const question = Core.activeQuestion(sections);
      if (!question) {
        stability.reset();
        liveResults = null;
        publish("waiting", "No open question was found.");
        return;
      }
      if (question.answerType !== "SINGLE_ANSWER" || question.enableGroups) {
        stability.reset();
        liveResults = null;
        publish("unsupported", "Only individual, single-answer A-E polls are supported.");
        return;
      }
      const questionName = typeof question.name === "string" ? question.name.replace(/\s+/g, " ").trim() : "";
      const heading = ` ${view.heading} `;
      if (!questionName || !heading.includes(` ${questionName} `)) {
        stability.reset();
        liveResults = null;
        publish("waiting", "Waiting for the displayed question to match the live poll.");
        return;
      }
      const questionKey = `${courseId}/${question.activityId}/${question.questionId}`;
      let result;
      try {
        const unavailable = unavailableReports.get(questionKey);
        if (unavailable && Date.now() < unavailable.retryAt) {
          liveResults = unavailable;
          result = { kind: "unavailable", rows: [] };
        } else {
          const report = await getJson(
            `/v2/reporting/courses/${courseId}/activities/${question.activityId}/questions/view`,
            controller.signal
          );
          if (!current() || !sameView(view)) return;
          result = Core.leadingAnswer(report, question.questionId, [...view.buttons.keys()]);
          unavailableReports.delete(questionKey);
          liveResults = {
            state: ["leader", "tie"].includes(result.kind) ? "available" : result.kind,
            outcome: result.kind,
            answer: result.answer || null,
            percentage: result.percentage ?? null,
            httpStatus: 200,
            checkedAt: Date.now(),
            retryAt: null,
            message: result.kind === "unavailable" ? "The current question has no readable live results."
              : result.kind === "empty" ? "The live report contains no votes yet."
              : "Live vote counts are available."
          };
        }
      } catch (error) {
        if (!current() || !sameView(view)) return;
        if (!(error instanceof RequestError) || ![403, 404].includes(error.httpStatus)) {
          liveResults = {
            state: "error", httpStatus: error.httpStatus || null,
            checkedAt: Date.now(), retryAt: null,
            message: controller.signal.aborted ? "The live-results request timed out."
              : `Live results could not be read: ${error.message}`
          };
          throw error;
        }
        // Missing reports can become readable during the same question; never cache them forever.
        liveResults = {
          state: "unavailable",
          httpStatus: error.httpStatus,
          checkedAt: Date.now(),
          retryAt: Date.now() + REPORT_RETRY,
          message: error.httpStatus === 403
            ? "iClicker denied access to live results (HTTP 403)."
            : "The live report is not available yet (HTTP 404)."
        };
        unavailableReports.set(questionKey, liveResults);
        result = { kind: "unavailable", rows: [] };
      }
      if (!current() || !sameView(view)) return;
      const extra = { rows: result.rows, question: questionName };
      const useRandom = randomFallback && ["unavailable", "empty"].includes(result.kind);
      if (result.kind !== "leader" && !useRandom) {
        stability.reset();
        const messages = {
          unavailable: "Live vote counts are unavailable. Continuing to check; no answer has been changed.",
          empty: "No votes yet. Waiting for a clear leader.",
          tie: "The leading answers are tied. Keeping your current answer."
        };
        publish(result.kind, messages[result.kind], extra);
        return;
      }
      let answer = result.answer;
      if (useRandom) {
        stability.reset();
        const selected = [...view.buttons].find(([, button]) => isSelected(button));
        if (selected) {
          lastAttempt = null;
          publish("random", `Live votes unavailable. Keeping your selected answer ${selected[0]}.`, extra);
          return;
        }
        const choices = [...view.buttons].filter(([, button]) => isEnabled(button)).map(([letter]) => letter);
        if (!choices.length) {
          publish("waiting", "The answer buttons are disabled. Waiting for iClicker.");
          return;
        }
        if (!randomAnswers.has(questionKey)) {
          randomAnswers.set(questionKey, choices[Math.floor(Math.random() * choices.length)]);
        }
        answer = randomAnswers.get(questionKey);
      }
      const button = view.buttons.get(answer);
      if (!button) {
        throw new Core.DataError("The available answer choices changed. Stopped without selecting another letter.");
      }
      if (isSelected(button)) {
        stability.reset();
        lastAttempt = null;
        publish("selected", `${answer} is selected and leads with ${result.percentage}%.`, extra);
        return;
      }
      if (!useRandom && !stability.observe(questionKey, answer)) {
        publish("observing", `${answer} leads with ${result.percentage}%. Confirming on the next update.`, extra);
        return;
      }
      const liveQuestion = await getJson(`/v2/questions/${question.questionId}`, controller.signal);
      if (!current() || !sameView(view)) return;
      if ((liveQuestion.questionId || liveQuestion._id) !== question.questionId ||
          liveQuestion.activityId !== question.activityId ||
          liveQuestion.ended || liveQuestion.answerType !== "SINGLE_ANSWER" || liveQuestion.enableGroups) {
        stability.reset();
        liveResults = null;
        publish("waiting", "The question changed or closed. No answer was selected.");
        return;
      }
      if (!isEnabled(button)) {
        stability.reset();
        publish("waiting", "The answer buttons are disabled. Waiting for iClicker.");
        return;
      }
      const attempt = `${questionKey}/${answer}`;
      if (lastAttempt === attempt) {
        enabled = false;
        publish("error", "iClicker did not confirm the selection. Paused to avoid repeated submissions; check the page.", extra);
        return;
      }
      lastAttempt = attempt;
      button.click();
      await recordSelection({
        courseId,
        activityId: question.activityId,
        questionId: question.questionId,
        questionName,
        answer,
        source: useRandom ? "random" : "live",
        percentage: useRandom ? null : result.percentage
      });
      if (!current()) return;
      publish("sending", useRandom
        ? `Selected ${answer} randomly because live votes are unavailable. Waiting for iClicker to confirm.`
        : `Selected ${answer} (${result.percentage}%). Waiting for iClicker to confirm.`, extra);
    } catch (error) {
      if (error instanceof HistoryError) {
        enabled = false;
        resetWork(true);
        publish("error", error.message);
        return;
      }
      if (!current()) return;
      stability.reset();
      if (controller.signal.aborted) {
        publish("error", "The iClicker request timed out. Retrying shortly.");
        delay = 15000;
      } else {
        if (!(error instanceof RequestError) || error.permanent) enabled = false;
        delay = error.retryAfter || INTERVAL;
        publish("error", error.message || "Unexpected extension error. Stopped.");
      }
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
      running = false;
      schedule(delay);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "MAJORITY_STATUS") {
      sendResponse(status);
    } else if (message?.type === "MAJORITY_START") {
      if (!enabled) {
        resetWork();
        enabled = true;
        publish("waiting", "Started for this tab. Waiting for a live poll.");
        schedule(0);
      }
      sendResponse(status);
    } else if (message?.type === "MAJORITY_STOP") {
      enabled = false;
      resetWork();
      publish("off", "Paused. Nothing will be selected.");
      sendResponse(status);
    } else if (message?.type === "MAJORITY_OPTIONS") {
      if (typeof message.randomFallback !== "boolean") {
        sendResponse({ ...status, kind: "error", message: "Invalid random-fallback setting." });
        return;
      }
      if (randomFallback !== message.randomFallback) {
        randomFallback = message.randomFallback;
        resetWork(true);
        publish(enabled ? "waiting" : "off", enabled
          ? "Settings updated. Checking the current poll."
          : "Paused. Nothing will be selected.");
        schedule(0);
      }
      sendResponse(status);
    }
  });

  setInterval(() => {
    if (location.href !== route) {
      route = location.href;
      resetWork();
      if (enabled) {
        publish("waiting", "Page changed. Waiting for a live poll.");
        schedule(0);
      }
    }
  }, 500);
  window.addEventListener("pagehide", () => {
    enabled = false;
    resetWork();
  });
})();
