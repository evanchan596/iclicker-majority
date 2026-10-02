"use strict";

(() => {
  const REQUESTS = new Set(["STUDENT_GET", "AI_ANSWER"]);
  const QUERY = "?recordsPerPage=1&pageNumber=1&expandChild=activities&expandChild=questions";

  function clientTag() {
    const agent = navigator.userAgent;
    const edge = agent.match(/Edg\/([\d.]+)/);
    const chrome = agent.match(/Chrome\/([\d.]+)/);
    const windows = agent.match(/Windows NT ([\d.]+)/);
    const mac = agent.match(/Mac OS X ([\d_]+)/);
    const os = windows ? "Win" : mac ? "Mac" : /Linux/.test(agent) ? "Linux" : "Other";
    const version = windows?.[1] || mac?.[1].replaceAll("_", ".") || "Unknown";
    return `ICLICKER/STUDENT-WEB/${new Date().toISOString()}/${os}/${version}/${edge ? "Microsoft Edge" : "Chrome"}/Web-Browser/${edge?.[1] || chrome?.[1] || "Unknown"}`;
  }

  async function handle(message, sender) {
    const courseId = IClickerMajority.courseFromUrl(sender.url || "");
    if (!sender.tab || sender.frameId !== 0 || !courseId) {
      throw new Error("This request must come from an iClicker poll.");
    }
    if (message.type === "AI_ANSWER") {
      const input = IClickerMajority.aiInput(message.input);
      let timer;
      try {
        const result = await Promise.race([
          chrome.runtime.sendMessage({ type: "LOCAL_AI_INFER", input }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, error: "Local AI did not respond within 25 seconds." }), 25000);
          })
        ]);
        if (!result) throw new Error("No AI engine responded.");
        return result;
      } catch (error) {
        return { ok: false, error: "Local AI is not ready. Open AI setup and keep that tab open." };
      } finally { clearTimeout(timer); }
    }
    const path = message.path;
    const allowed = typeof path === "string" && (
      path === `/v2/courses/${courseId}/class-sections${QUERY}` ||
      new RegExp(`^/v2/reporting/courses/${courseId}/activities/[a-zA-Z0-9_-]{1,128}/questions/view$`).test(path) ||
      /^\/v2\/questions\/[a-zA-Z0-9_-]{1,128}$/.test(path)
    );
    if (!allowed || typeof message.token !== "string" || !message.token ||
        message.token.length > 16384 || /[\r\n]/.test(message.token)) {
      throw new Error("Invalid student API request.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`https://api.iclicker.com${path}`, {
        method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${message.token}`,
          "Reef-Auth-Type": "oauth",
          "Client-Tag": clientTag()
        }
      });
      return {
        ok: true, status: response.status, retryAfter: response.headers.get("Retry-After"),
        data: response.ok ? await response.json() : null
      };
    } finally { clearTimeout(timeout); }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !REQUESTS.has(message?.type)) return;
    handle(message, sender).then(reply, (error) => reply({ ok: false, error: error.message }));
    return true;
  });
})();
