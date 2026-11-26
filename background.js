// Redline background service worker. Swarm Rebuild provides the visual page
// reconstruction; Redline adds its live-page audit and AI redesign tools.
importScripts("design-skills.js", "redline-background.js");

const MEDIA_ONLY_CSS = `
html body *:not(canvas):not(video):not(iframe):not(embed):not(object) { visibility: hidden !important; }
html body canvas, html body video, html body iframe, html body embed, html body object { visibility: visible !important; }
`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingRuns = new Map();

function startSwarm(tab) {
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || "")) return Promise.resolve();
  const previous = pendingRuns.get(tab.id) || Promise.resolve();
  const run = previous.then(() => runSwarm(tab)).catch(() => {});
  pendingRuns.set(tab.id, run);
  run.finally(() => { if (pendingRuns.get(tab.id) === run) pendingRuns.delete(tab.id); });
  return run;
}

async function isActiveTab(tab) {
  try { return (await chrome.tabs.get(tab.id)).active; } catch { return false; }
}

async function runSwarm(tab) {
  const target = { tabId: tab.id };
  let hidden = false;
  try {
    const [{ result: state }] = await chrome.scripting.executeScript({
      target,
      func: () => {
        if (window.__redline) { window.__redline.toggle(); return { running: true }; }
        if (window.__swarmRebuild) { window.__swarmRebuild.toggle(); return { running: true }; }
        if (window.__redlineRebuild) { window.__redlineRebuild.toggle(); return { running: true }; }
        const hasMedia = [...document.querySelectorAll("canvas, video, iframe, embed, object")].some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        });
        return { running: false, hasMedia };
      },
    });
    if (state?.running) return;

    if (state?.hasMedia && await isActiveTab(tab)) {
      try {
        await chrome.scripting.insertCSS({ target, css: MEDIA_ONLY_CSS });
        hidden = true;
        await sleep(90);
        if (!(await isActiveTab(tab))) throw new Error("Page is no longer active");
        const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        if (!(await isActiveTab(tab))) throw new Error("Page changed during capture");
        await chrome.scripting.executeScript({
          target,
          func: (shot) => { window.__swarmShot = shot; window.__swarmHidden = true; },
          args: [screenshot],
        });
      } catch {
        if (hidden) {
          await chrome.scripting.removeCSS({ target, css: MEDIA_ONLY_CSS }).catch(() => {});
          hidden = false;
        }
      }
    }

    await chrome.scripting.executeScript({ target, files: ["swarm-engine.js"] });
    if (hidden) {
      const [{ result: running }] = await chrome.scripting.executeScript({
        target,
        func: () => {
          if (window.__swarmRebuild?.app) return true;
          window.__swarmShot = null;
          window.__swarmHidden = false;
          return false;
        },
      });
      if (!running) await chrome.scripting.removeCSS({ target, css: MEDIA_ONLY_CSS }).catch(() => {});
    }
  } catch (error) {
    if (hidden) await chrome.scripting.removeCSS({ target, css: MEDIA_ONLY_CSS }).catch(() => {});
    console.warn("Redline could not start the Swarm rebuild:", error);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#E5254B" }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {}), 2500);
  }
}

chrome.action.onClicked.addListener((tab) => startSwarm(tab));

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === "swarm:unhide" && sender.tab?.id) {
    const target = sender.documentId
      ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
      : { tabId: sender.tab.id };
    chrome.scripting.removeCSS({ target, css: MEDIA_ONLY_CSS })
      .catch(() => {})
      .then(() => reply(true));
    return true;
  }
  if (message?.type !== "redline:start" || !sender.tab?.id) return;
  const target = sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id };
  chrome.scripting.executeScript({ target, files: ["design-skills.js", "content.js"] })
    .then(() => reply(true), (error) => reply({ error: String(error?.message || error) }));
  return true;
});
