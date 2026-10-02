"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");
const source = fs.readFileSync(path.join(__dirname, "..", "ai.js"), "utf8");
const input = { text: "Which number is even? A: 1 B: 2", image: null, choices: ["A", "B"] };

function harness({ supported = true, images = false } = {}) {
  let prepare;
  let listener;
  let timeout;
  const element = { textContent: "", disabled: false, addEventListener: (event, fn) => { prepare = fn; } };
  const status = { textContent: "" };
  const state = { output: '{"answer":"B"}', prompts: [], destroyed: 0, block: false };
  const context = {
    IClickerMajority: Core, AbortController,
    console: { warn() {} },
    document: { getElementById: (id) => id === "prepare-ai" ? element : status },
    chrome: { runtime: { id: "ext", onMessage: { addListener: (fn) => { listener = fn; } } } },
    setTimeout: (fn) => { timeout = fn; return 1; },
    clearTimeout: () => {},
    fetch: async () => ({ blob: async () => "image-blob" })
  };
  if (supported) context.LanguageModel = {
    availability: async (options) => options.expectedInputs.some((item) => item.type === "image") && !images
      ? "unavailable" : "available",
    create: async () => ({
      destroy: () => { state.destroyed += 1; },
      prompt: async (messages, options) => {
        state.prompts.push({ messages, options });
        if (!state.block) return state.output;
        return new Promise((resolve, reject) => options.signal.addEventListener("abort",
          () => reject(new Error("Aborted")), { once: true }));
      }
    })
  };
  vm.runInNewContext(source, context);
  function send(value = input, sender = { id: "ext" }) {
    return new Promise((resolve) => {
      const handled = listener({ type: "LOCAL_AI_INFER", input: value }, sender,
        (reply) => resolve(structuredClone(reply)));
      if (handled !== true) resolve(undefined);
    });
  }
  return { state, status, prepare: () => prepare(), send, expire: () => timeout() };
}

test("local AI requires explicit preparation and does not run when unsupported", async () => {
  const h = harness({ supported: false });
  await h.prepare();
  assert.match(h.status.textContent, /unavailable/);
  assert.equal((await h.send()).ok, false);
  assert.equal(h.state.prompts.length, 0);
});

test("prepared local AI requests a constrained single letter and destroys sessions", async () => {
  const h = harness();
  await h.prepare();
  assert.deepEqual(await h.send(), { ok: true, answer: "B" });
  assert.deepEqual(structuredClone(h.state.prompts[0].options.responseConstraint.properties.answer.enum), ["A", "B", null]);
  assert.match(h.state.prompts[0].messages[0].content[0].value, /Which number is even/);
  assert.equal(h.state.destroyed, 2);
});

test("invalid or uncertain model output does not become a fabricated answer", async () => {
  const h = harness();
  await h.prepare();
  for (const value of ['{"answer":null}', '{"answer":"E"}', "Answer B", "garbage"]) {
    h.state.output = value;
    assert.equal((await h.send()).ok, false);
  }
});

test("image-only questions require ready image support", async () => {
  const h = harness();
  await h.prepare();
  const result = await h.send({ ...input, text: "", image: "data:image/png;base64,AAAA" });
  assert.equal(result.ok, false);
  assert.match(result.error, /image AI is unavailable/);
});

test("only the extension worker can invoke inference, never a page directly", async () => {
  const h = harness();
  await h.prepare();
  assert.equal(await h.send(input, { id: "foreign" }), undefined);
  assert.equal(await h.send(input, { id: "ext", tab: { id: 1 } }), undefined);
  assert.equal(h.state.prompts.length, 0);
});

test("hung inference times out and releases the local engine", async () => {
  const h = harness();
  await h.prepare();
  h.state.block = true;
  const result = h.send();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.match((await h.send()).error, /busy/);
  h.expire();
  assert.match((await result).error, /timed out/);
  h.state.block = false;
  assert.equal((await h.send()).ok, true);
});
