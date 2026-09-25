"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

function report(values, extra = {}) {
  return { questions: [{
    questionId: "q1",
    answerOverview: Object.entries(values).map(([answer, percentageOfTotalResponses]) => ({
      answer, percentageOfTotalResponses
    })),
    ...extra
  }] };
}
const choices = ["A", "B", "C", "D", "E"];
const active = (questions, overrides = {}) => [{
  activities: [{ _id: "a1", activityType: "POLL", questions }],
  ...overrides
}];

test("only matches the exact live student poll route", () => {
  assert.equal(Core.courseFromUrl("https://student.iclicker.com/#/class/c1/poll"), "c1");
  for (const url of [
    "https://student.iclicker.com/#/class/c1/question/q1",
    "https://student.iclicker.com/#/class/c1/quiz/a1",
    "https://student.iclicker.com.evil.example/#/class/c1/poll",
    "https://student.iclicker.com/#/class/c1/poll/extra"
  ]) assert.equal(Core.courseFromUrl(url), null);
});

test("chooses the current question, not the last historical question", () => {
  const question = Core.activeQuestion(active([
    { _id: "q1", ended: null },
    { _id: "q2", ended: "2026-01-01" }
  ]));
  assert.equal(question.questionId, "q1");
  assert.equal(question.activityId, "a1");
  assert.equal(Core.activeQuestion([]), null);
  assert.equal(Core.activeQuestion(active([{ _id: "q1" }], { ended: "2026-01-01" })), null);
});

test("rejects ambiguous or invalid active questions", () => {
  assert.throws(() => Core.activeQuestion(active([{ _id: "q1" }, { _id: "q2" }])), Core.DataError);
  assert.throws(() => Core.activeQuestion(active([{ _id: "../bad" }])), Core.DataError);
  assert.throws(() => Core.activeQuestion({ activities: [] }), Core.DataError);
  assert.equal(Core.activeQuestion([{ activities: [{ activityType: "QUIZ", questions: [{ _id: "q1" }] }] }]), null);
});

test("selects plurality, including percentages encoded as strings", () => {
  const result = Core.leadingAnswer(report({ A: 25, b: "40.0", C: 35 }), "q1", choices);
  assert.equal(result.answer, "B");
  assert.equal(result.percentage, 40);
});

test("does not substitute historical results for missing live counts", () => {
  assert.equal(Core.leadingAnswer(report({ A: 100 }), "q2", choices).kind, "unavailable");
  assert.equal(Core.leadingAnswer(report({}), "q1", choices).kind, "unavailable");
});

test("zero votes and rounded ties do not select an answer", () => {
  assert.equal(Core.leadingAnswer(report({ A: 0, B: 0 }), "q1", choices).kind, "empty");
  assert.equal(Core.leadingAnswer(report({ A: 50, B: 50 }), "q1", choices).kind, "tie");
  assert.equal(Core.leadingAnswer(report({ A: 100 }, { responseCount: 0 }), "q1", choices).kind, "empty");
});

test("rejects partial, malformed, duplicate and non-choice distributions", () => {
  for (const values of [
    { A: 20, B: 30 }, { A: null, B: 100 }, { A: -1, B: 101 },
    { A: true, B: 99 }, { A: "50%", B: 50 }, { F: 100 }, { A: 50, a: 50 }
  ]) assert.throws(() => Core.leadingAnswer(report(values), "q1", choices), Core.DataError);
  assert.throws(() => Core.leadingAnswer(report({ B: 100 }), "q1", ["A"]), Core.DataError);
  assert.throws(() => Core.leadingAnswer({}, "q1", choices), Core.DataError);
});

test("accepts normal percentage rounding", () => {
  assert.equal(Core.leadingAnswer(report({ A: 34, B: 33, C: 33 }), "q1", choices).answer, "A");
  assert.equal(Core.leadingAnswer(report({ A: 33.3, B: 33.3, C: 33.4 }), "q1", choices).answer, "C");
});

test("requires two observations and resets across ties and question changes", () => {
  const stability = new Core.Stability();
  assert.equal(stability.observe("q1", "A"), false);
  assert.equal(stability.observe("q1", "A"), true);
  assert.equal(stability.observe("q1", "B"), false);
  assert.equal(stability.observe("q2", "B"), false);
  stability.reset();
  assert.equal(stability.observe("q2", "B"), false);
  assert.equal(stability.observe("q2", "B"), true);
});
