(function (root) {
  "use strict";

  class DataError extends Error {}

  function id(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
      ? value
      : null;
  }

  function courseFromUrl(value) {
    const url = new URL(value);
    if (url.origin !== "https://student.iclicker.com") return null;
    const match = url.hash.match(/^#\/class\/([a-zA-Z0-9_-]+)\/poll\/?(?:\?.*)?$/);
    return match ? id(match[1]) : null;
  }

  function activeQuestion(sections) {
    if (!Array.isArray(sections)) {
      throw new DataError("iClicker's class response has an unsupported format.");
    }
    if (!sections.length || sections[0].ended) return null;
    if (!Array.isArray(sections[0].activities)) {
      throw new DataError("The current class has no readable activity list.");
    }
    const questions = [];
    for (const activity of sections[0].activities) {
      if (activity.activityType !== "POLL" || activity.ended) continue;
      if (!Array.isArray(activity.questions)) {
        throw new DataError("The current poll has no readable question list.");
      }
      for (const question of activity.questions) {
        if (question.ended) continue;
        const questionId = id(question.questionId || question._id);
        const activityId = id(activity.activityId || activity._id);
        if (!questionId || !activityId) {
          throw new DataError("The active question is missing valid identifiers.");
        }
        questions.push({ ...question, questionId, activityId });
      }
    }
    if (questions.length > 1) {
      throw new DataError("More than one question is open. No answer was selected.");
    }
    return questions[0] || null;
  }

  function number(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
      return null;
    }
    return Number(value);
  }

  function leadingAnswer(report, questionId, choices) {
    if (!report || !Array.isArray(report.questions)) {
      throw new DataError("iClicker's results response has an unsupported format.");
    }
    const matches = report.questions.filter(
      (question) => (question.questionId || question._id) === questionId
    );
    if (!matches.length) return { kind: "unavailable", rows: [] };
    if (matches.length !== 1) throw new DataError("Duplicate question results received.");
    const question = matches[0];
    if (!Array.isArray(question.answerOverview) || !question.answerOverview.length) {
      return { kind: "unavailable", rows: [] };
    }
    const rows = [];
    const seen = new Set();
    for (const entry of question.answerOverview) {
      const answer = typeof entry.answer === "string" ? entry.answer.trim().toUpperCase() : "";
      const percentage = number(entry.percentageOfTotalResponses);
      if (!/^[A-E]$/.test(answer) || !choices.includes(answer) || seen.has(answer) ||
          percentage === null || percentage < 0 || percentage > 100) {
        throw new DataError("The vote distribution is incomplete or unsupported. No answer was selected.");
      }
      seen.add(answer);
      rows.push({ answer, percentage });
    }
    if (rows.every((row) => row.percentage === 0) || number(question.responseCount) === 0) {
      return { kind: "empty", rows };
    }
    // Account for ordinary rounding, but reject partial distributions rather than guess.
    const total = rows.reduce((sum, row) => sum + row.percentage, 0);
    if (Math.abs(total - 100) > Math.max(0.1, rows.length * 0.51)) {
      throw new DataError("The reported percentages do not form a complete distribution.");
    }
    rows.sort((a, b) => b.percentage - a.percentage || a.answer.localeCompare(b.answer));
    if (rows.length > 1 && rows[0].percentage === rows[1].percentage) {
      return { kind: "tie", rows };
    }
    return { kind: "leader", answer: rows[0].answer, percentage: rows[0].percentage, rows };
  }

  class Stability {
    constructor() {
      this.reset();
    }
    reset() {
      this.question = null;
      this.answer = null;
      this.observations = 0;
    }
    observe(question, answer) {
      if (this.question !== question || this.answer !== answer) {
        this.question = question;
        this.answer = answer;
        this.observations = 0;
      }
      this.observations += 1;
      return this.observations >= 2;
    }
  }

  const api = { DataError, id, courseFromUrl, activeQuestion, leadingAnswer, Stability };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IClickerMajority = Object.freeze(api);
})(globalThis);
