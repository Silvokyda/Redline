// Redline background service worker.
// Toggles the overlay on the active tab, takes screenshots for the AI pass,
// and calls the AI provider with the user's own key. Keys never leave this
// worker except in the request to the provider the user picked.

const DEFAULTS = {
  provider: "anthropic",
  anthropicModel: "claude-sonnet-5-5",
  openaiModel: "gpt-4.1",
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "screenshot" || msg?.type === "exportPng") {
    (async () => {
      try {
        if (!sender.tab?.id) throw new Error("No active page is available for capture.");
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
        if (activeTab?.id !== sender.tab.id) throw new Error("Switch back to the page being scanned before capturing it.");
        const dataUrl = msg.type === "exportPng"
          ? await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
          : await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 75 });
        reply({ ok: true, dataUrl });
      } catch (err) {
        reply({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "settings") {
    getSettings().then((s) => reply({
      hasKey: !!activeKey(s),
      provider: s.provider,
      activeDesignSkill: s.activeDesignSkill || "balanced",
      designSkills: availableDesignSkills(s),
    }));
    return true;
  }
  if (msg?.type === "openOptions") {
    chrome.runtime.openOptionsPage();
  }
  if (msg?.type === "testKey") {
    testKey().then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

async function testKey() {
  const s = await getSettings();
  const key = activeKey(s);
  if (!key) return { ok: false, error: "Paste a key first." };
  const prompt = 'Reply with exactly {"ok":true}';
  const result = s.provider === "openai"
    ? await callOpenAI(key, s.openaiModel, prompt, null)
    : await callAnthropic(key, s.anthropicModel, prompt, null);
  return { ok: /ok/.test(result.text), model: s.provider === "openai" ? s.openaiModel : s.anthropicModel };
}

// Long AI calls go over a port, which keeps the service worker alive.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "redline-ai") return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "redesign" && msg?.type !== "review") return;
    try {
      const result = msg.type === "review"
        ? await reviewPage(msg.page, msg.screenshot, msg.brief, msg.skillId, msg.includeMobile)
        : await redesign(msg.page, msg.screenshot, msg.brief, msg.skillId, msg.includeMobile);
      port.postMessage({ ok: true, ...result });
    } catch (err) {
      port.postMessage({ ok: false, error: String(err?.message || err) });
    }
  });
});

async function getSettings() {
  const s = await chrome.storage.local.get([
    "provider", "anthropicKey", "openaiKey", "anthropicModel", "openaiModel",
    "redlineCustomSkills", "activeDesignSkill",
  ]);
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) };
}

function availableDesignSkills(settings) {
  const builtins = globalThis.REDLINE_DESIGN_SKILLS || [];
  const custom = Array.isArray(settings.redlineCustomSkills)
    ? settings.redlineCustomSkills.filter((skill) =>
        skill && typeof skill.id === "string" && skill.id.startsWith("custom-") &&
        typeof skill.name === "string" && typeof skill.instructions === "string" &&
        skill.instructions.length <= 12000)
    : [];
  return [...builtins, ...custom];
}

function activeKey(s) {
  return s.provider === "openai" ? s.openaiKey : s.anthropicKey;
}

const SYSTEM_PROMPT = `You are a senior product designer and product manager reviewing a live web page. You receive a screenshot and a JSON list of visible elements with text, dimensions, parent/child relationships, and current visual/layout styles.

Think about the user's primary task, the page's audience, information hierarchy, content clarity, and the path to the main action. Produce a cohesive, usable redesign: adjust typography, page/section layout, content grouping, responsive behavior, spacing, and colors when those changes help. Use the element relationships to target the right container or component. Keep the brand recognizable and preserve working controls, meaning, and content order. Do not invent product facts, features, prices, guarantees, or claims.

Rules:
- Treat this as a product design review, not a surface-only style pass. Make targeted changes to the section or container that needs them.
- Preserve the page's existing layout modes and composition. Do not switch an element between block, flex, or grid. Refine flex settings only on existing flex containers, grid tracks only on existing grid containers, and item alignment only where the parent already uses flex or grid. Do not change position, hide elements, or visually reorder content.
- Keep the current brand, page purpose, navigation, section order, and working controls. A selected design skill guides visual details only; it must not force an editorial, portfolio, or app-like structure onto a different kind of product. Avoid broad restyling when the existing design is already coherent.
- Check for generic AI styling: emoji used as interface icons, decorative gradients unrelated to the brand, repeated identical cards, unnecessary all-caps eyebrows, filler copy, or inconsistent icon styles. Call these out only when they are actually present and harm this page. Suggest a specific, restrained replacement; prefer the site's existing icon library, or consistent Lucide SVG icons if the project has none. Preserve gradients and decoration that are purposeful and on-brand.
- Use system font stacks only. Never hide, remove, or make existing text transparent. Use font sizes of at least 12px. Keep text/background contrast at 4.5:1 or higher.
- If text sits over a photo, gradient, or uncertain background, preserve its current color instead of guessing a new one.
- You may improve headings, button labels, and short descriptions using "text" only for elements marked "leaf": true. Keep the original meaning, avoid unsupported claims, and keep replacement text under 240 characters.
- When mobile layout is requested, add "mobileStyles" for changes needed at 640px and below. Use it for responsive layout, sizing, spacing, and type adjustments; ordinary "styles" apply to the current viewport. Do not duplicate desktop values into mobileStyles without a reason.
- Only use these CSS properties: color, background-color, font-family, font-size, font-weight, line-height, letter-spacing, text-align, text-transform, width, min-width, max-width, height, min-height, max-height, flex-direction, flex-wrap, flex-grow, flex-shrink, flex-basis, align-items, align-self, justify-content, justify-self, grid-template-columns, grid-template-rows, grid-auto-flow, padding, padding-top, padding-right, padding-bottom, padding-left, margin, margin-top, margin-right, margin-bottom, margin-left, gap, row-gap, column-gap, border, border-color, border-width, border-radius, box-shadow.
- At most 24 changes. Prefer a few clear, high-impact improvements over broad restyling. If the page is already coherent, make only small refinements.
- Each "reason" is one short sentence a non-designer understands. "role" is one of: contrast, type, spacing, layout, color, copy.

Reply with JSON only, no prose and no code fences, in this shape:
{"summary":"one sentence describing the direction","tokens":{"palette":{"name":"#hex"},"fontStack":"...","typeScale":["14px","16px"]},"changes":[{"id":0,"role":"layout","styles":{"grid-template-columns":"repeat(3, minmax(0, 1fr))","gap":"24px"},"mobileStyles":{"grid-template-columns":"1fr","gap":"16px"},"text":null,"reason":"The cards now form a clear responsive group."}]}`;

async function redesign(page, screenshot, brief, skillId, includeMobile) {
  const s = await getSettings();
  const key = activeKey(s);
  if (!key) throw new Error("No API key set. Add one in Redline's options.");

  const skills = availableDesignSkills(s);
  const skill = skills.find((item) => item.id === skillId) || skills.find((item) => item.id === "balanced");
  // Keep skills provider-neutral: both adapters receive this same text alongside the page data.
  const skillText = skill
    ? `Selected design skill: ${skill.name}\nApply this style guidance while following all output and safety rules above:\n${skill.instructions}`
    : "Use the balanced product design direction.";

  const userText =
    (brief ? `Direction from the site owner: ${brief}\n\n` : "") +
    `${skillText}\n\n` +
    (includeMobile
      ? "Create additional mobileStyles rules for screens 640 CSS px wide and below, targeting a typical 390px phone viewport. The current screenshot and measurements represent the active viewport; use the element hierarchy and current layout to produce a sensible compact responsive version.\n\n"
      : "Do not include mobileStyles; redesign only the current viewport.\n\n") +
    `Page: ${page.url}\nTitle: ${page.title}\nViewport: ${page.viewport.w}x${page.viewport.h}\n\nElements:\n${JSON.stringify(page.elements)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const result = s.provider === "openai"
      ? await callOpenAI(key, s.openaiModel, userText, screenshot, ctrl.signal)
      : await callAnthropic(key, s.anthropicModel, userText, screenshot, ctrl.signal);
    return { plan: parseJSON(result.text), usage: result.usage };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("The AI took too long to answer. Try again, or pick a faster model.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const REVIEW_PROMPT = `You are reviewing the result of a live webpage redesign. You receive a fresh screenshot and a fresh element/layout summary after the changes have been applied. Check whether the page is visually coherent, readable, faithful to its existing brand and purpose, and whether key sections, text, and controls still fit and remain in the right order. Also check for obvious AI-style clichés such as gratuitous emoji icons, decorative gradients that conflict with the brand, repeated identical cards, all-caps labels used only as decoration, filler copy, and mismatched icon styles. Mention only patterns visible in this page and offer a concrete alternative; do not invent issues.

Only request a repair when a visible problem is clear from the screenshot or measurements. Do not redesign the page again or make aesthetic changes just because you prefer another style. If the result is acceptable, return ok:true and an empty changes array. If there is a clear regression, return ok:false with up to 12 small, targeted corrections using the same safe CSS rules and element ids. Never invent content or hide/reorder content.

Reply with JSON only in this shape:
{"ok":true,"summary":"The page remains readable and its main sections fit.","changes":[]}
or {"ok":false,"summary":"The statistics are compressed into a narrow column.","changes":[{"id":0,"role":"layout","styles":{"width":"100%"},"mobileStyles":{},"text":null,"reason":"The section should use the available content width."}]}`;

async function reviewPage(page, screenshot, brief, skillId, includeMobile) {
  const s = await getSettings();
  const key = activeKey(s);
  if (!key) throw new Error("No API key set. Add one in Redline's options.");
  const userText = `Review the finished page against its starting purpose and design direction.\nPage: ${page.url}\nTitle: ${page.title}\nViewport: ${page.viewport.w}x${page.viewport.h}\nOriginal direction: ${brief || "Keep the site's existing visual identity while improving usability."}\nMobile rules requested: ${includeMobile ? "yes" : "no"}\nSelected design skill: ${skillId || "balanced"}\n\nCurrent page elements:\n${JSON.stringify(page.elements)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const result = s.provider === "openai"
      ? await callOpenAI(key, s.openaiModel, userText, screenshot, ctrl.signal, REVIEW_PROMPT)
      : await callAnthropic(key, s.anthropicModel, userText, screenshot, ctrl.signal, REVIEW_PROMPT);
    return { plan: parseJSON(result.text), usage: result.usage };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("The AI review took too long. You can still review the result yourself.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(key, model, userText, screenshot, signal, systemPrompt = SYSTEM_PROMPT) {
  const content = [];
  if (screenshot) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot.split(",")[1] } });
  }
  content.push({ type: "text", text: userText });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: 8000, system: systemPrompt, messages: [{ role: "user", content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(providerError("Anthropic", res.status, data?.error?.message));
  return {
    text: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    usage: data.usage ? {
      input: (data.usage.input_tokens || 0) + (data.usage.cache_creation_input_tokens || 0) + (data.usage.cache_read_input_tokens || 0),
      output: data.usage.output_tokens || 0,
    } : null,
  };
}

async function callOpenAI(key, model, userText, screenshot, signal, systemPrompt = SYSTEM_PROMPT) {
  const content = [{ type: "text", text: userText }];
  if (screenshot) content.push({ type: "image_url", image_url: { url: screenshot } });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(providerError("OpenAI", res.status, data?.error?.message));
  return {
    text: data.choices?.[0]?.message?.content || "",
    usage: data.usage ? { input: data.usage.prompt_tokens || 0, output: data.usage.completion_tokens || 0 } : null,
  };
}

function providerError(name, status, detail) {
  if (status === 401) return `${name} rejected the API key. Check it in Redline's options.`;
  if (status === 404) return `${name} doesn't recognise that model name. Change it in Redline's options.`;
  if (status === 429) return `${name} rate limit or quota reached. Wait a moment or check your billing.`;
  return `${name} error ${status}${detail ? `: ${detail}` : ""}`;
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The AI's answer wasn't in the expected format. Try again.");
  return JSON.parse(clean.slice(start, end + 1));
}
