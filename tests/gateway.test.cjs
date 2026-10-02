"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");
const source = fs.readFileSync(path.join(__dirname, "..", "gateway.js"), "utf8");
const sender = { id: "ext", frameId: 0, tab: { id: 1 }, url: "https://student.iclicker.com/#/class/c1/poll" };
const request = { type: "STUDENT_GET", path: "/v2/reporting/courses/c1/activities/a1/questions/view", token: "synthetic-token" };

function harness() {
  let listener;
  const requests = [];
  const forwarded = [];
  const state = { status: 200, aiResult: { ok: true, answer: "D" }, aiThrows: false };
  vm.runInNewContext(source, {
    IClickerMajority: Core, AbortController, Date, setTimeout, clearTimeout,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36" },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: state.status, ok: state.status === 200, headers: { get: () => "60" },
        json: async () => ({ questions: [] }) };
    },
    chrome: { runtime: {
      id: "ext",
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: async (message) => {
        forwarded.push(structuredClone(message));
        if (state.aiThrows) throw new Error("No receiver");
        return state.aiResult;
      }
    } }
  });
  function send(message, from = sender) {
    return new Promise((resolve) => {
      const handled = listener(message, from, (reply) => resolve(structuredClone(reply)));
      if (handled !== true) resolve(undefined);
    });
  }
  return { send, requests, forwarded, state };
}

test("student reads use only fixed iClicker host with the account token and client tag", async () => {
  const h = harness();
  const response = await h.send(request);
  assert.equal(response.status, 200);
  assert.equal(h.requests[0].url, `https://api.iclicker.com${request.path}`);
  assert.equal(h.requests[0].options.method, "GET");
  assert.equal(h.requests[0].options.redirect, "error");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.requests[0].options.headers.Authorization, "Bearer synthetic-token");
  assert.match(h.requests[0].options.headers["Client-Tag"], /^ICLICKER\/STUDENT-WEB\//);
  assert.match(h.requests[0].options.headers["Client-Tag"], /\/Win\/10\.0\/Chrome\/Web-Browser\/141\.0\.0\.0$/);
});

test("the gateway rejects arbitrary URLs, cross-course reports, embedded paths, and invalid senders", async () => {
  const h = harness();
  for (const value of [
    "https://evil.example/steal", "//evil.example/", "/v2/questions/../profile",
    "/v2/reporting/courses/c2/activities/a1/questions/view", "/v2/questions/q1?redirect=evil"
  ]) assert.equal((await h.send({ ...request, path: value })).ok, false);
  assert.equal((await h.send(request, { ...sender, frameId: 1 })).ok, false);
  assert.equal((await h.send(request, { ...sender, url: "https://evil.example/" })).ok, false);
  assert.equal(await h.send(request, { ...sender, id: "foreign" }), undefined);
  assert.equal(h.requests.length, 0);
});

test("HTTP errors and retry headers propagate without fabricating vote counts", async () => {
  const h = harness();
  h.state.status = 403;
  const response = await h.send(request);
  assert.equal(response.status, 403);
  assert.equal(response.data, null);
  assert.equal(response.retryAfter, "60");
});

test("AI requests are bounded and sent only to the extension's local engine", async () => {
  const h = harness();
  const input = { text: "Which option? A: one B: two D: four", image: null, choices: ["A", "B", "D"] };
  const response = await h.send({ type: "AI_ANSWER", input, token: "not-for-ai" });
  assert.equal(response.answer, "D");
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.forwarded[0], { type: "LOCAL_AI_INFER", input });
  h.state.aiThrows = true;
  assert.match((await h.send({ type: "AI_ANSWER", input })).error, /not ready/);
});
