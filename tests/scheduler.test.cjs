"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "scheduler.js"), "utf8");

function harness(store = {}) {
  let listener;
  let onAlarm;
  let onUpdated;
  let onRemoved;
  let now = 100000;
  const timers = new Map();
  const calls = [];
  const updates = [];
  let nextTimer = 1;
  const state = { reachable: true, enabled: true };
  const sender = { id: "ext", tab: { id: 5 }, frameId: 0, documentId: "doc1", url: "https://student.iclicker.com/#/class/c1/poll" };
  const context = {
    console: { warn() {}, error() {} },
    Date: { now: () => now },
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      runtime: { id: "ext", getURL: (file) => `chrome-extension://ext/${file}`, onMessage: { addListener: (fn) => { listener = fn; } } },
      storage: { session: {
        get: async () => structuredClone(store),
        set: async (values) => Object.assign(store, structuredClone(values))
      } },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: (fn) => { onAlarm = fn; } } },
      tabs: {
        get: async () => ({ id: 5, autoDiscardable: true, url: sender.url }),
        update: async (id, values) => { updates.push({ id, ...values }); },
        sendMessage: async (id, message, options) => {
          calls.push({ id, message, options });
          if (!state.reachable) throw new Error("Tab closed");
          return { enabled: state.enabled };
        },
        onUpdated: { addListener: (fn) => { onUpdated = fn; } },
        onRemoved: { addListener: (fn) => { onRemoved = fn; } }
      }
    }
  };
  vm.runInNewContext(source, context);
  async function flush() { for (let i = 0; i < 60; i += 1) await Promise.resolve(); }
  async function send(enabled, delay = 5000, from = sender) {
    const response = await new Promise((resolve) => {
      const handled = listener({ type: "POLL_SCHEDULE", enabled, delay }, from, resolve);
      if (handled !== true) resolve(undefined);
    });
    await flush();
    return response;
  }
  async function wake() {
    const [id, timer] = [...timers][0];
    timers.delete(id);
    now += timer.delay;
    timer.fn();
    await flush();
  }
  return { store, sender, state, calls, updates, timers, flush, send, wake,
    list: async () => new Promise((resolve) => listener({ type: "POLL_RUNNING" },
      { id: "ext", url: "chrome-extension://ext/popup.html", tab: { id: 6 } }, resolve)),
    alarm: async () => { now += 30000; onAlarm({ name: "poll-watchdog" }); await flush(); },
    removed: async () => { onRemoved(5); await flush(); },
    updated: async (change) => { onUpdated(5, change); await flush(); }
  };
}

test("worker timers wake the exact document without relying on tab focus", async () => {
  const h = harness();
  await h.flush();
  assert.equal((await h.send(true)).ok, true);
  await h.wake();
  assert.equal(h.calls[0].message.type, "MAJORITY_TICK");
  assert.equal(h.calls[0].options.documentId, "doc1");
  assert.equal(h.updates[0].autoDiscardable, false);
  await h.send(false);
  assert.equal(h.updates.at(-1).autoDiscardable, true);
  assert.deepEqual(h.store.runningPollTabs, {});
  assert.equal(h.timers.size, 0);
});

test("worker suspension can recover stored jobs from the alarm", async () => {
  const first = harness();
  await first.flush();
  await first.send(true);
  const restarted = harness(first.store);
  await restarted.flush();
  await restarted.alarm();
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.calls[0].options.documentId, "doc1");
});

test("paused, unreachable, reloaded and closed tabs are removed", async () => {
  for (const mode of ["paused", "closed", "reload", "removed"]) {
    const h = harness();
    await h.flush();
    await h.send(true);
    if (mode === "paused") { h.state.enabled = false; await h.wake(); }
    if (mode === "closed") { h.state.reachable = false; await h.wake(); }
    if (mode === "reload") await h.updated({ status: "loading" });
    if (mode === "removed") await h.removed();
    assert.deepEqual(h.store.runningPollTabs, {});
    assert.equal(h.timers.size, 0);
  }
});

test("invalid and foreign scheduling messages cannot create polling jobs", async () => {
  const h = harness();
  await h.flush();
  assert.equal(await h.send(true, 0, { ...h.sender, id: "foreign" }), undefined);
  assert.equal((await h.send(true, -1)).ok, false);
  assert.equal((await h.send(true, 0, { ...h.sender, frameId: 1 })).ok, false);
  assert.equal((await h.send(true, 0, { ...h.sender, url: "https://evil.example/" })).ok, false);
  assert.deepEqual(h.store.runningPollTabs, {});
});

test("an old document cannot stop a newly registered document", async () => {
  const h = harness();
  await h.flush();
  await h.send(true);
  await h.send(true, 5000, { ...h.sender, documentId: "doc2" });
  await h.send(false);
  assert.equal(h.store.runningPollTabs[5].documentId, "doc2");
});

test("the popup can find and control the running iClicker tab from another tab", async () => {
  const h = harness();
  await h.flush();
  await h.send(true);
  assert.deepEqual(structuredClone(await h.list()), { ok: true, tabIds: [5] });
  await h.send(false);
  assert.deepEqual(structuredClone(await h.list()), { ok: true, tabIds: [] });
});
