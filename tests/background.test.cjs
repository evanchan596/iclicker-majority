"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const directory = path.join(__dirname, "..");
const background = fs.readFileSync(path.join(directory, "background.js"), "utf8");
const sender = {
  id: "test-extension",
  tab: { id: 1 },
  url: "https://student.iclicker.com/#/class/c1/poll"
};
const selection = {
  courseId: "c1", activityId: "a1", questionId: "q1", questionName: "Question 1",
  answer: "B", source: "live", percentage: 60
};

function createHarness(store = {}) {
  let listener;
  const state = { failGet: false, failSet: false };
  let context;
  context = vm.createContext({
    URL, crypto, Date, Set,
    importScripts: (file) => {
      assert.equal(file, "core.js");
      vm.runInContext(fs.readFileSync(path.join(directory, file), "utf8"), context);
    },
    chrome: {
      runtime: {
        id: "test-extension",
        onMessage: { addListener: (fn) => { listener = fn; } }
      },
      storage: { local: {
        get: async (key) => {
          await Promise.resolve();
          if (state.failGet) throw new Error("Storage read failed.");
          return { [key]: structuredClone(store[key]) };
        },
        set: async (values) => {
          await Promise.resolve();
          if (state.failSet) throw new Error("Storage write failed.");
          Object.assign(store, structuredClone(values));
        }
      } }
    }
  });
  vm.runInContext(background, context, { filename: "background.js" });
  function send(message, from = sender) {
    return new Promise((resolve) => {
      const async = listener(message, from, (response) => resolve(structuredClone(response)));
      if (async !== true) resolve(undefined);
    });
  }
  return { send, state, store };
}

test("saves a timestamped source record without retaining extra fields or credentials", async () => {
  const h = createHarness();
  const result = await h.send({
    type: "HISTORY_ADD",
    selection: { ...selection, unwantedData: "must not persist" }
  });
  assert.equal(result.ok, true);
  const { entries } = await h.send({ type: "HISTORY_LIST" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "live");
  assert.equal(entries[0].percentage, 60);
  assert.ok(Number.isFinite(Date.parse(entries[0].timestamp)));
  assert.match(entries[0].id, /^[0-9a-f-]{36}$/);
  assert.equal("unwantedData" in entries[0], false);
});

test("random records never claim a live-vote percentage", async () => {
  const h = createHarness();
  await h.send({ type: "HISTORY_ADD", selection: { ...selection, source: "random" } });
  assert.equal(h.store.answerHistory[0].percentage, null);
});

test("concurrent tabs retain both picks instead of overwriting one another", async () => {
  const h = createHarness();
  const results = await Promise.all([
    h.send({ type: "HISTORY_ADD", selection }),
    h.send({ type: "HISTORY_ADD", selection: { ...selection, questionId: "q2", answer: "C" } },
      { ...sender, tab: { id: 2 } })
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(h.store.answerHistory.length, 2);
  assert.equal(new Set(h.store.answerHistory.map((entry) => entry.id)).size, 2);
  assert.deepEqual(h.store.answerHistory.map((entry) => entry.answer), ["C", "B"]);
});

test("keeps only the newest 200 selection attempts", async () => {
  const h = createHarness();
  for (let index = 0; index < 205; index += 1) {
    await h.send({ type: "HISTORY_ADD", selection: { ...selection, questionId: `q${index}` } });
  }
  assert.equal(h.store.answerHistory.length, 200);
  assert.equal(h.store.answerHistory[0].questionId, "q204");
  assert.equal(h.store.answerHistory.at(-1).questionId, "q5");
});

test("history survives a worker restart and clearing does not remove other settings", async () => {
  const first = createHarness({ unrelatedPreference: true });
  await first.send({ type: "HISTORY_ADD", selection });
  const restarted = createHarness(first.store);
  assert.equal((await restarted.send({ type: "HISTORY_LIST" })).entries.length, 1);
  await restarted.send({ type: "HISTORY_CLEAR" });
  assert.deepEqual(restarted.store.answerHistory, []);
  assert.equal(restarted.store.unrelatedPreference, true);
});

test("clear and in-flight append requests are ordered consistently", async () => {
  const h = createHarness();
  await Promise.all([
    h.send({ type: "HISTORY_ADD", selection }),
    h.send({ type: "HISTORY_CLEAR" }),
    h.send({ type: "HISTORY_ADD", selection: { ...selection, answer: "E" } })
  ]);
  assert.deepEqual(h.store.answerHistory.map((entry) => entry.answer), ["E"]);
});

test("storage failures are surfaced and do not poison the operation queue", async () => {
  const h = createHarness();
  h.state.failSet = true;
  const failure = await h.send({ type: "HISTORY_ADD", selection });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /Storage write failed/);
  h.state.failSet = false;
  assert.equal((await h.send({ type: "HISTORY_ADD", selection })).ok, true);
  h.state.failGet = true;
  assert.equal((await h.send({ type: "HISTORY_LIST" })).ok, false);
  h.state.failGet = false;
  assert.equal((await h.send({ type: "HISTORY_LIST" })).entries.length, 1);
});

test("unreadable storage is not silently replaced until the user clears it", async () => {
  const h = createHarness({ answerHistory: "bad data" });
  assert.equal((await h.send({ type: "HISTORY_ADD", selection })).ok, false);
  assert.equal(h.store.answerHistory, "bad data");
  assert.equal((await h.send({ type: "HISTORY_CLEAR" })).ok, true);
  assert.deepEqual(h.store.answerHistory, []);
});

test("invalid sources, letters, identifiers, and percentages are rejected", async () => {
  const h = createHarness();
  for (const change of [
    { source: "manual" }, { answer: "F" }, { questionName: "" },
    { courseId: "../c1" }, { percentage: -1 }, { percentage: NaN }, { percentage: "60" }
  ]) {
    assert.equal((await h.send({ type: "HISTORY_ADD", selection: { ...selection, ...change } })).ok, false);
  }
  assert.equal(h.store.answerHistory, undefined);
});

test("only this extension can use history and records must come from the matching student poll", async () => {
  const h = createHarness();
  assert.equal(await h.send({ type: "HISTORY_CLEAR" }, { id: "another-extension" }), undefined);
  assert.equal(await h.send({ type: "OTHER_MESSAGE" }), undefined);
  for (const from of [
    { ...sender, url: "https://evil.example/#/class/c1/poll" },
    { ...sender, url: "https://student.iclicker.com/#/class/c2/poll" },
    { id: sender.id, url: sender.url }
  ]) {
    assert.equal((await h.send({ type: "HISTORY_ADD", selection }, from)).ok, false);
  }
});
