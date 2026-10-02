"use strict";

(() => {
  const KEY = "runningPollTabs";
  const ALARM = "poll-watchdog";
  let jobs = {};
  let timer;
  let queue = chrome.storage.session.get(KEY).then((data) => { jobs = data[KEY] || {}; });

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch((error) => { console.error("Background poll scheduler:", error.message); });
    return result;
  }

  async function arm() {
    clearTimeout(timer);
    await chrome.storage.session.set({ [KEY]: jobs });
    const pending = Object.values(jobs);
    if (!pending.length) {
      await chrome.alarms.clear(ALARM);
      return;
    }
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    const due = Math.min(...pending.map((job) => job.due));
    timer = setTimeout(() => { enqueue(wake); }, Math.max(0, due - Date.now()));
  }

  async function remove(tabId) {
    const job = jobs[tabId];
    delete jobs[tabId];
    if (job) {
      try {
        await chrome.tabs.update(Number(tabId), { autoDiscardable: job.autoDiscardable });
      } catch (error) {
        console.warn("Could not restore closed/unavailable tab:", error.message);
      }
    }
  }

  async function wake() {
    for (const [tabId, job] of Object.entries(jobs)) {
      if (job.due > Date.now()) continue;
      // A pending inference or a delayed tab gets a watchdog, not overlapping ticks.
      job.due = Date.now() + 30000;
      try {
        const result = await chrome.tabs.sendMessage(Number(tabId),
          { type: "MAJORITY_TICK" }, { documentId: job.documentId });
        if (!result?.enabled) await remove(tabId);
      } catch (error) {
        console.warn("Polling tab is no longer reachable:", error.message);
        await remove(tabId);
      }
    }
    await arm();
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "POLL_RUNNING" &&
        (!sender.tab || sender.url === chrome.runtime.getURL("popup.html"))) {
      enqueue(() => Object.keys(jobs).map(Number)).then(
        (tabIds) => reply({ ok: true, tabIds }),
        (error) => reply({ ok: false, error: error.message })
      );
      return true;
    }
    if (message?.type !== "POLL_SCHEDULE") return;
    if (!sender.tab || sender.frameId !== 0 || !sender.documentId ||
        !sender.url?.startsWith("https://student.iclicker.com/") ||
        typeof message.enabled !== "boolean" || !Number.isFinite(message.delay) ||
        message.delay < 0 || message.delay > 86400000) {
      reply({ ok: false, error: "Invalid background polling request." });
      return;
    }
    enqueue(async () => {
      const tabId = sender.tab.id;
      if (!message.enabled) {
        if (jobs[tabId]?.documentId === sender.documentId) await remove(tabId);
      } else {
        const current = await chrome.tabs.get(tabId);
        if (!current.url?.startsWith("https://student.iclicker.com/")) {
          throw new Error("The polling tab has left iClicker.");
        }
        const previous = jobs[tabId];
        jobs[tabId] = {
          documentId: sender.documentId,
          due: Date.now() + message.delay,
          autoDiscardable: previous?.autoDiscardable ?? current.autoDiscardable ?? true
        };
        await chrome.tabs.update(tabId, { autoDiscardable: false });
      }
      await arm();
    }).then(() => reply({ ok: true }), (error) => reply({ ok: false, error: error.message }));
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) enqueue(wake);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    enqueue(async () => { delete jobs[tabId]; await arm(); });
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" || (change.url && !change.url.startsWith("https://student.iclicker.com/"))) {
      enqueue(async () => { await remove(tabId); await arm(); });
    }
  });
  enqueue(wake);
})();
