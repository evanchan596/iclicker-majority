"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");
const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function createHarness() {
  const timers = new Map();
  const intervals = [];
  let nextTimer = 1;
  let listener;
  const state = {
    now: Date.parse("2026-09-25T01:30:00Z"),
    heading: "Question 1",
    votes: { A: 20, B: 60, C: 20 },
    enabledControls: true,
    disabledAnswers: [],
    hiddenAnswers: [],
    visible: true,
    selected: "",
    clicked: [],
    history: [],
    historyError: null,
    beforeHistory: null,
    requests: [],
    resultsStatus: 200,
    sectionsStatus: 200,
    questionStatus: 200,
    randomValues: [0.55],
    randomCalls: 0,
    confirmClick: true,
    token: "test-token",
    question: {
      _id: "q1", activityId: "a1", name: "Question 1",
      answerType: "SINGLE_ANSWER", ended: null
    },
    beforeResults: null,
    beforeQuestion: null
  };
  const location = { href: "https://student.iclicker.com/#/class/c1/poll" };
  const buttons = ["A", "B", "C", "D", "E"].map((answer) => ({
    textContent: answer,
    getClientRects: () => state.hiddenAnswers.includes(answer) ? [] : [1],
    get disabled() { return !state.enabledControls || state.disabledAnswers.includes(answer); },
    getAttribute: () => null,
    classList: { contains: () => state.selected === answer },
    click: () => {
      state.clicked.push(answer);
      if (state.confirmClick) state.selected = answer;
    }
  }));
  const root = {
    getClientRects: () => [1],
    closest: () => ({ querySelector: () => ({ textContent: state.heading }) }),
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("button") ? buttons : []
  };
  const context = {
    IClickerMajority: Core,
    URL, Map, Set, AbortController, Error,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [state.now])); }
      static now() { return state.now; }
    },
    Math: Object.assign(Object.create(Math), {
      random: () => state.randomValues[Math.min(state.randomCalls++, state.randomValues.length - 1)]
    }),
    location,
    document: { querySelectorAll: () => state.visible ? [root] : [] },
    sessionStorage: { getItem: () => state.token },
    chrome: {
      runtime: {
        id: "test-extension",
        onMessage: { addListener: (callback) => { listener = callback; } },
        sendMessage: async (message) => {
          assert.equal(message.type, "HISTORY_ADD");
          await state.beforeHistory?.();
          if (state.historyError) return { ok: false, error: state.historyError };
          state.history.push(structuredClone(message.selection));
          return { ok: true, id: String(state.history.length) };
        }
      }
    },
    window: { addEventListener: () => {} },
    setTimeout: (fn, delay) => {
      const timer = nextTimer++;
      timers.set(timer, { fn, delay });
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    setInterval: (fn) => intervals.push(fn),
    fetch: async (url, options) => {
      state.requests.push({ url, options });
      assert.equal(new URL(url).origin, "https://api.iclicker.com");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      let body;
      let status = 200;
      if (url.includes("/class-sections")) {
        status = state.sectionsStatus;
        body = [{ activities: [{
          _id: "a1", activityType: "POLL", questions: [{ ...state.question }]
        }] }];
      } else if (url.includes("/reporting/")) {
        await state.beforeResults?.();
        status = state.resultsStatus;
        body = { questions: [{
          questionId: state.question._id,
          answerOverview: Object.entries(state.votes).map(([answer, percentageOfTotalResponses]) => ({
            answer, percentageOfTotalResponses
          }))
        }] };
      } else if (url.includes("/v2/questions/")) {
        await state.beforeQuestion?.();
        status = state.questionStatus;
        body = { ...state.question };
      } else {
        throw new Error(`Unexpected request ${url}`);
      }
      return {
        status, ok: status === 200,
        headers: { get: () => null },
        json: async () => body
      };
    }
  };
  vm.runInNewContext(source, context, { filename: "content.js" });
  function send(type, sender = "test-extension") {
    let result;
    listener(typeof type === "string" ? { type } : type, { id: sender }, (response) => { result = response; });
    return result;
  }
  async function step() {
    const entry = [...timers].find(([, item]) => item.delay !== 12000);
    assert.ok(entry, "a polling timer should be scheduled");
    timers.delete(entry[0]);
    state.now += entry[1].delay;
    await entry[1].fn();
  }
  return { state, location, send, step, timers, routeChanged: () => intervals[0]() };
}

test("defaults off, uses only authorized GETs, and confirms a stable leader", async () => {
  const h = createHarness();
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
  assert.equal(h.send("MAJORITY_STATUS").randomFallback, false);
  assert.equal(h.timers.size, 0);
  h.send("MAJORITY_START");
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.send("MAJORITY_STATUS").kind, "observing");
  await h.step();
  assert.deepEqual(h.state.clicked, ["B"]);
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").kind, "selected");
  assert.deepEqual(h.state.clicked, ["B"]);
  h.send("MAJORITY_STOP");
  assert.equal(h.timers.size, 0);
  assert.equal(h.send("MAJORITY_STATUS").kind, "off");
});

test("follows a new leader only after two further readings", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  await h.step();
  await h.step();
  h.state.votes = { A: 80, B: 20 };
  await h.step();
  assert.deepEqual(h.state.clicked, ["B"]);
  await h.step();
  assert.deepEqual(h.state.clicked, ["B", "A"]);
});

test("ties, empty results, and stale report IDs never select a fallback", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  for (const [votes, kind] of [[{ A: 50, B: 50 }, "tie"], [{}, "unavailable"], [{ A: 0, B: 0 }, "empty"]]) {
    h.state.votes = votes;
    await h.step();
    assert.equal(h.send("MAJORITY_STATUS").kind, kind);
  }
  h.state.votes = { B: 100 };
  h.state.beforeResults = () => { h.state.question._id = "q2"; };
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").kind, "unavailable");
  assert.deepEqual(h.state.clicked, []);
});

test("authentication errors stop without retrying or guessing", async () => {
  const h = createHarness();
  h.state.resultsStatus = 401;
  h.send("MAJORITY_START");
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
  assert.equal(h.send("MAJORITY_STATUS").kind, "error");
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.state.clicked, []);
});

test("rate limiting backs off instead of continuing the five-second cadence", async () => {
  const h = createHarness();
  h.state.resultsStatus = 429;
  h.send("MAJORITY_START");
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").enabled, true);
  assert.equal([...h.timers.values()][0].delay, 60000);
});

test("stopping during a result request prevents the pending click", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  await h.step();
  h.state.beforeResults = () => { h.send("MAJORITY_STOP"); };
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.timers.size, 0);
  assert.equal(h.send("MAJORITY_STATUS").kind, "off");
});

test("navigation or a changed question header invalidates in-flight results", async () => {
  for (const change of ["route", "heading"]) {
    const h = createHarness();
    h.send("MAJORITY_START");
    await h.step();
    h.state.beforeResults = () => {
      if (change === "route") h.location.href = "https://student.iclicker.com/#/courses";
      else h.state.heading = "Question 2";
    };
    await h.step();
    assert.deepEqual(h.state.clicked, []);
  }
});

test("checks question closure immediately before clicking", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  await h.step();
  h.state.beforeQuestion = () => { h.state.question.ended = "2026-09-24T23:00:00Z"; };
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.send("MAJORITY_STATUS").kind, "waiting");
});

test("disabled controls and question-name collisions do not receive clicks", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  h.state.heading = "Question 10";
  await h.step();
  assert.equal(h.state.requests.length, 1);
  h.state.heading = "Question 1";
  h.state.enabledControls = false;
  await h.step();
  await h.step();
  assert.deepEqual(h.state.clicked, []);
});

test("unsupported question types, group polls, and quiz routes are ignored", async () => {
  for (const kind of ["group", "text", "quiz"]) {
    const h = createHarness();
    if (kind === "group") h.state.question.enableGroups = true;
    if (kind === "text") h.state.question.answerType = "SHORT_ANSWER";
    if (kind === "quiz") h.location.href = "https://student.iclicker.com/#/class/c1/quiz/a1";
    h.send("MAJORITY_START");
    await h.step();
    await h.step();
    assert.deepEqual(h.state.clicked, []);
    assert.equal(h.state.requests.some((request) => request.url.includes("/reporting")), false);
  }
});

test("unconfirmed clicks pause rather than repeatedly submit", async () => {
  const h = createHarness();
  h.state.confirmClick = false;
  h.send("MAJORITY_START");
  await h.step();
  await h.step();
  await h.step();
  assert.deepEqual(h.state.clicked, ["B"]);
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
  assert.match(h.send("MAJORITY_STATUS").message, /did not confirm/);
});

test("missing sign-in token and malformed distributions fail closed", async () => {
  for (const kind of ["token", "distribution"]) {
    const h = createHarness();
    if (kind === "token") h.state.token = null;
    else h.state.votes = { A: 20, B: 10 };
    h.send("MAJORITY_START");
    await h.step();
    assert.equal(h.send("MAJORITY_STATUS").enabled, false);
    assert.deepEqual(h.state.clicked, []);
  }
});

test("a page or other extension cannot send start commands", () => {
  const h = createHarness();
  h.send("MAJORITY_START", "other-extension");
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
});

function enableFallback(h) {
  h.send({ type: "MAJORITY_OPTIONS", randomFallback: true });
  h.send("MAJORITY_START");
}

test("random fallback picks once for missing counts and confirms without re-rolling", async () => {
  const h = createHarness();
  h.state.votes = {};
  enableFallback(h);
  await h.step();
  assert.deepEqual(h.state.clicked, ["C"]);
  assert.match(h.send("MAJORITY_STATUS").message, /randomly/);
  await h.step();
  await h.step();
  assert.deepEqual(h.state.clicked, ["C"]);
  assert.equal(h.state.randomCalls, 1);
  assert.equal(h.send("MAJORITY_STATUS").kind, "random");
  assert.ok(h.state.requests.some((request) => request.url.endsWith("/v2/questions/q1")));
});

test("zero responses trigger fallback, but a visible tie does not", async () => {
  const h = createHarness();
  enableFallback(h);
  h.state.votes = { A: 50, B: 50 };
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.state.randomCalls, 0);
  h.state.votes = { A: 0, B: 0 };
  await h.step();
  assert.deepEqual(h.state.clicked, ["C"]);
});

test("reporting 403/404 use fallback without retrying during the cooldown", async () => {
  for (const status of [403, 404]) {
    const h = createHarness();
    h.state.resultsStatus = status;
    enableFallback(h);
    await h.step();
    await h.step();
    await h.step();
    assert.deepEqual(h.state.clicked, ["C"]);
    assert.equal(h.send("MAJORITY_STATUS").enabled, true);
    assert.equal(h.state.requests.filter((request) => request.url.includes("/reporting/")).length, 1);
  }
});

test("a missing current result can fall back only after the current question is verified", async () => {
  const h = createHarness();
  enableFallback(h);
  h.state.beforeResults = () => { h.state.question._id = "q2"; };
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.send("MAJORITY_STATUS").kind, "waiting");
});

test("fallback samples only enabled, visible letters, including interval endpoints", async () => {
  for (const [sample, expected] of [[0, "C"], [0.999999, "D"]]) {
    const h = createHarness();
    h.state.disabledAnswers = ["A", "B"];
    h.state.hiddenAnswers = ["E"];
    h.state.randomValues = [sample];
    h.state.votes = {};
    enableFallback(h);
    await h.step();
    assert.deepEqual(h.state.clicked, [expected]);
  }
});

test("fallback preserves manual answers and previous majority selections", async () => {
  const h = createHarness();
  h.state.selected = "D";
  h.state.votes = {};
  enableFallback(h);
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.state.randomCalls, 0);
  h.state.selected = "";
  h.state.votes = { B: 100 };
  await h.step();
  await h.step();
  h.state.votes = {};
  await h.step();
  assert.deepEqual(h.state.clicked, ["B"]);
  assert.equal(h.state.randomCalls, 0);
});

test("readable counts replace a random choice after two stable majority readings", async () => {
  const h = createHarness();
  h.state.votes = {};
  enableFallback(h);
  await h.step();
  h.state.votes = { A: 80, C: 20 };
  await h.step();
  assert.deepEqual(h.state.clicked, ["C"]);
  await h.step();
  assert.deepEqual(h.state.clicked, ["C", "A"]);
});

test("a new question gets its own random draw while pause/resume keeps the previous draw", async () => {
  const h = createHarness();
  h.state.votes = {};
  h.state.randomValues = [0, 0.99];
  enableFallback(h);
  await h.step();
  h.send("MAJORITY_STOP");
  h.state.selected = "";
  h.send("MAJORITY_START");
  await h.step();
  assert.deepEqual(h.state.clicked, ["A", "A"]);
  assert.equal(h.state.randomCalls, 1);
  h.state.question._id = "q2";
  h.state.question.name = "Question 2";
  h.state.heading = "Question 2";
  h.state.selected = "";
  await h.step();
  assert.deepEqual(h.state.clicked, ["A", "A", "E"]);
  assert.equal(h.state.randomCalls, 2);
});

test("fallback still refuses closed questions, disabled controls, and changed pages", async () => {
  for (const kind of ["closed", "disabled", "route", "heading", "stopped"]) {
    const h = createHarness();
    h.state.votes = {};
    enableFallback(h);
    if (kind === "disabled") h.state.enabledControls = false;
    h.state.beforeQuestion = () => {
      if (kind === "closed") h.state.question.ended = "2026-09-24T23:00:00Z";
      if (kind === "route") h.location.href = "https://student.iclicker.com/#/courses";
      if (kind === "heading") h.state.heading = "Question 2";
      if (kind === "stopped") h.send("MAJORITY_STOP");
    };
    await h.step();
    assert.deepEqual(h.state.clicked, []);
  }
});

test("sign-in and non-reporting access failures never trigger random submission", async () => {
  for (const kind of ["token", "report-auth", "section-access", "question-access"]) {
    const h = createHarness();
    h.state.votes = {};
    if (kind === "token") h.state.token = null;
    if (kind === "report-auth") h.state.resultsStatus = 401;
    if (kind === "section-access") h.state.sectionsStatus = 403;
    if (kind === "question-access") h.state.questionStatus = 404;
    enableFallback(h);
    await h.step();
    assert.deepEqual(h.state.clicked, []);
    assert.equal(h.send("MAJORITY_STATUS").enabled, false);
  }
});

test("fallback does not guess after rate limiting, network/server failures, or malformed data", async () => {
  for (const kind of ["rate-limit", "server", "network", "malformed"]) {
    const h = createHarness();
    if (kind === "rate-limit") h.state.resultsStatus = 429;
    if (kind === "server") h.state.resultsStatus = 503;
    if (kind === "network") h.state.beforeResults = () => { throw new TypeError("Network error"); };
    if (kind === "malformed") h.state.votes = { A: 20 };
    enableFallback(h);
    await h.step();
    assert.deepEqual(h.state.clicked, []);
    assert.equal(h.state.randomCalls, 0);
    if (kind === "rate-limit") assert.equal([...h.timers.values()][0].delay, 60000);
  }
});

test("an unconfirmed random click pauses without re-rolling or resubmitting", async () => {
  const h = createHarness();
  h.state.votes = {};
  h.state.confirmClick = false;
  enableFallback(h);
  await h.step();
  await h.step();
  assert.deepEqual(h.state.clicked, ["C"]);
  assert.equal(h.state.randomCalls, 1);
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
});

test("turning fallback off cancels an in-flight random submission", async () => {
  const h = createHarness();
  h.state.votes = {};
  enableFallback(h);
  h.state.beforeQuestion = () => {
    h.send({ type: "MAJORITY_OPTIONS", randomFallback: false });
  };
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.send("MAJORITY_STATUS").randomFallback, false);
  await h.step();
  assert.deepEqual(h.state.clicked, []);
  assert.equal(h.send("MAJORITY_STATUS").kind, "unavailable");
});

test("settings do not start automation and reject invalid or external updates", () => {
  const h = createHarness();
  h.send({ type: "MAJORITY_OPTIONS", randomFallback: true }, "other-extension");
  assert.equal(h.send("MAJORITY_STATUS").randomFallback, false);
  assert.equal(h.send({ type: "MAJORITY_OPTIONS", randomFallback: "true" }).kind, "error");
  h.send({ type: "MAJORITY_OPTIONS", randomFallback: true });
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
  assert.equal(h.send("MAJORITY_STATUS").randomFallback, true);
  assert.equal(h.timers.size, 0);
});

test("history records the source and percentage of each actual automatic click", async () => {
  const h = createHarness();
  h.state.votes = {};
  enableFallback(h);
  await h.step();
  await h.step();
  h.state.votes = { A: 80, C: 20 };
  await h.step();
  await h.step();
  await h.step();
  assert.deepEqual(h.state.history, [
    { courseId: "c1", activityId: "a1", questionId: "q1", questionName: "Question 1",
      answer: "C", source: "random", percentage: null },
    { courseId: "c1", activityId: "a1", questionId: "q1", questionName: "Question 1",
      answer: "A", source: "live", percentage: 80 }
  ]);
  assert.equal(h.state.clicked.length, h.state.history.length);
});

test("a random pick later matching the majority is not relabeled or logged again", async () => {
  const h = createHarness();
  h.state.votes = {};
  enableFallback(h);
  await h.step();
  h.state.votes = { C: 100 };
  await h.step();
  await h.step();
  assert.equal(h.state.history.length, 1);
  assert.equal(h.state.history[0].source, "random");
  assert.equal(h.state.history[0].percentage, null);
});

test("manual answers, ties, and aborted selections never create history entries", async () => {
  const h = createHarness();
  h.state.selected = "B";
  enableFallback(h);
  await h.step();
  h.state.votes = {};
  await h.step();
  h.state.selected = "";
  h.state.votes = { A: 50, B: 50 };
  await h.step();
  h.state.votes = {};
  h.state.beforeQuestion = () => { h.state.question.ended = "2026-09-24T23:00:00Z"; };
  await h.step();
  assert.deepEqual(h.state.history, []);
});

test("unconfirmed clicks remain recorded as selection attempts without duplicates", async () => {
  const h = createHarness();
  h.state.votes = {};
  h.state.confirmClick = false;
  enableFallback(h);
  await h.step();
  await h.step();
  assert.equal(h.state.history.length, 1);
  assert.equal(h.state.history[0].source, "random");
  assert.equal(h.send("MAJORITY_STATUS").enabled, false);
});

test("storage failures pause explicitly after the clicked answer, even if the user stopped", async () => {
  for (const stopDuringSave of [false, true]) {
    const h = createHarness();
    h.state.votes = {};
    h.state.historyError = "Storage is full.";
    if (stopDuringSave) h.state.beforeHistory = () => { h.send("MAJORITY_STOP"); };
    enableFallback(h);
    await h.step();
    assert.deepEqual(h.state.clicked, ["C"]);
    assert.deepEqual(h.state.history, []);
    assert.equal(h.send("MAJORITY_STATUS").enabled, false);
    assert.match(h.send("MAJORITY_STATUS").message, /history could not be saved/);
    assert.match(h.send("MAJORITY_STATUS").message, /Storage is full/);
    assert.equal(h.timers.size, 0);
  }
});

test("a saved selection survives stopping while logging without overwriting paused status", async () => {
  const h = createHarness();
  h.state.votes = {};
  h.state.beforeHistory = () => { h.send("MAJORITY_STOP"); };
  enableFallback(h);
  await h.step();
  assert.equal(h.state.history.length, 1);
  assert.equal(h.send("MAJORITY_STATUS").kind, "off");
  assert.equal(h.timers.size, 0);
});

test("a temporary reporting error must not permanently lock in a random answer", async () => {
  for (const status of [403, 404]) {
    const h = createHarness();
    h.state.resultsStatus = status;
    enableFallback(h);
    await h.step();
    assert.deepEqual(h.state.clicked, ["C"]);
    h.state.resultsStatus = 200;
    h.state.votes = { A: 20, B: 70, C: 10 };
    for (let poll = 0; poll < 4; poll += 1) await h.step();
    assert.deepEqual(h.state.clicked, ["C", "B"]);
    assert.deepEqual(h.state.history.map((entry) => entry.source), ["random", "live"]);
    assert.equal(h.send("MAJORITY_STATUS").liveResults.state, "available");
  }
});

test("majority-only mode recovers when a missing live report becomes available", async () => {
  const h = createHarness();
  h.state.resultsStatus = 404;
  h.send("MAJORITY_START");
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").enabled, true);
  assert.equal(h.send("MAJORITY_STATUS").liveResults.httpStatus, 404);
  assert.deepEqual(h.state.clicked, []);
  h.state.resultsStatus = 200;
  for (let poll = 0; poll < 4; poll += 1) await h.step();
  assert.deepEqual(h.state.clicked, ["B"]);
});

test("live-results failures remain visible rather than being hidden by random fallback", async () => {
  const h = createHarness();
  h.state.resultsStatus = 403;
  enableFallback(h);
  await h.step();
  const results = h.send("MAJORITY_STATUS").liveResults;
  assert.equal(results.state, "unavailable");
  assert.equal(results.httpStatus, 403);
  assert.equal(results.retryAt, h.state.now + 15000);
  assert.equal(results.checkedAt, h.state.now);
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").liveResults.checkedAt, results.checkedAt);
});

test("persistently denied results retry only at the cooldown boundary without duplicate selections", async () => {
  const h = createHarness();
  h.state.resultsStatus = 403;
  enableFallback(h);
  const requests = () => h.state.requests.filter((request) => request.url.includes("/reporting/")).length;
  await h.step();
  await h.step();
  await h.step();
  assert.equal(requests(), 1);
  await h.step();
  assert.equal(requests(), 2);
  await h.step();
  await h.step();
  assert.equal(requests(), 2);
  await h.step();
  assert.equal(requests(), 3);
  assert.deepEqual(h.state.clicked, ["C"]);
  assert.equal(h.state.history.length, 1);
});

test("rate limits after a report retry still enforce a full backoff", async () => {
  const h = createHarness();
  h.state.resultsStatus = 404;
  enableFallback(h);
  await h.step();
  h.state.resultsStatus = 429;
  await h.step();
  await h.step();
  await h.step();
  assert.equal([...h.timers.values()][0].delay, 60000);
  assert.equal(h.send("MAJORITY_STATUS").liveResults.httpStatus, 429);
  h.state.resultsStatus = 200;
  await h.step();
  await h.step();
  assert.deepEqual(h.state.clicked, ["C", "B"]);
});

test("a report cooldown does not delay the next question or select after closure", async () => {
  for (const closed of [false, true]) {
    const h = createHarness();
    h.state.resultsStatus = 403;
    enableFallback(h);
    await h.step();
    h.state.resultsStatus = 200;
    h.state.selected = "";
    h.state.question._id = "q2";
    h.state.question.name = "Question 2";
    h.state.heading = "Question 2";
    await h.step();
    if (closed) h.state.beforeQuestion = () => { h.state.question.ended = "2026-09-25T01:30:10Z"; };
    await h.step();
    assert.deepEqual(h.state.clicked, closed ? ["C"] : ["C", "B"]);
  }
});

test("live visibility exposes the leader independently of the selected answer", async () => {
  const h = createHarness();
  h.state.selected = "D";
  h.send("MAJORITY_START");
  await h.step();
  const status = h.send("MAJORITY_STATUS");
  assert.equal(status.liveResults.outcome, "leader");
  assert.equal(status.liveResults.answer, "B");
  assert.equal(status.liveResults.percentage, 60);
  assert.equal(Core.majorityVisibility(status, h.state.now).label, "Yes");
  assert.deepEqual(h.state.clicked, []);
});

test("live visibility distinguishes ties, zero votes, and hidden results", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  for (const [votes, expected] of [
    [{ A: 50, B: 50 }, "Tied"], [{ A: 0, B: 0 }, "No votes yet"], [{}, "No"]
  ]) {
    h.state.votes = votes;
    await h.step();
    assert.equal(Core.majorityVisibility(h.send("MAJORITY_STATUS"), h.state.now).label, expected);
  }
  assert.deepEqual(h.state.clicked, []);
});

test("closed questions and pausing remove the previous majority indicator", async () => {
  const h = createHarness();
  h.send("MAJORITY_START");
  await h.step();
  assert.equal(Core.majorityVisibility(h.send("MAJORITY_STATUS"), h.state.now).label, "Yes");
  h.state.beforeQuestion = () => { h.state.question.ended = "2026-09-25T02:00:00Z"; };
  await h.step();
  assert.equal(h.send("MAJORITY_STATUS").liveResults, null);
  assert.equal(Core.majorityVisibility(h.send("MAJORITY_STATUS"), h.state.now).label, "Checking");
  h.send("MAJORITY_STOP");
  assert.equal(Core.majorityVisibility(h.send("MAJORITY_STATUS"), h.state.now).label, "Not checking");
});
