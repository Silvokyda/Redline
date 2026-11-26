// Redline background service worker. The toolbar action starts Redline's
// independently written cursor-led page rebuild engine.
importScripts("design-skills.js", "redline-background.js");

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:|^file:/.test(tab.url || "")) return;
  try {
    const [{ result: running }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.__redline) {
          window.__redline.toggle();
          return true;
        }
        if (window.__redlineRebuild) {
          window.__redlineRebuild.toggle();
          return true;
        }
        return false;
      },
    });
    if (!running) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["redline-rebuild.js"],
      });
    }
  } catch (error) {
    console.warn("Redline could not run on this page:", error);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#E5254B" }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {}), 2500);
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "redline:start" || !sender.tab?.id) return;
  const target = sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id };
  chrome.scripting.executeScript({ target, files: ["design-skills.js", "content.js"] })
    .then(() => reply(true), (error) => reply({ error: String(error?.message || error) }));
  return true;
});
