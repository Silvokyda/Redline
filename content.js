// Redline content script. Injected on demand into the tab the user clicked.
// 1. Scans the page and finds design problems it can fix locally.
// 2. Optionally asks the user's AI provider for a full redesign plan.
// 3. A crew of cursors walks the page and applies each change, live.
// Everything is applied as inline style overrides, so exiting restores the page.
(() => {
  if (window.__redline) return;

  // ---------------------------------------------------------------- config
  const ROLES = {
    contrast: { name: "Contrast", color: "#e5254b" },
    type: { name: "Type", color: "#2f6bff" },
    spacing: { name: "Spacing", color: "#d98a00" },
    layout: { name: "Layout", color: "#b14bcb" },
    color: { name: "Color", color: "#8a3ffc" },
    copy: { name: "Copy", color: "#0e9f6e" },
  };
  const ALLOWED = new Set([
    "color", "background-color", "font-family", "font-size", "font-weight", "line-height",
    "letter-spacing", "text-align", "text-transform", "width", "min-width", "max-width",
    "height", "min-height", "max-height", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink",
    "flex-basis", "align-items", "align-self", "justify-content", "justify-self", "grid-template-columns",
    "grid-template-rows", "grid-auto-flow", "padding", "padding-top", "padding-right", "padding-bottom",
    "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "gap",
    "row-gap", "column-gap", "border", "border-color", "border-width", "border-radius", "box-shadow",
  ]);
  const MOBILE_ALLOWED = new Set([
    "font-size", "line-height", "text-align", "width", "min-width", "max-width", "height", "min-height",
    "max-height", "flex-direction", "flex-wrap", "flex-basis", "align-items", "align-self",
    "justify-content", "justify-self", "grid-template-columns", "grid-template-rows", "grid-auto-flow",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-top",
    "margin-right", "margin-bottom", "margin-left", "gap", "row-gap", "column-gap",
  ]);
  const MAX_SCAN = 8000;
  const MAX_AI_ELEMENTS = 220;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- state
  const state = {
    speed: 1,
    follow: true,
    skip: false,
    runToken: 0,
    phase: "ready", // ready | thinking | working | done
    progress: { total: 0, done: 0 },
    entries: [],     // scanned elements
    byId: new Map(), // id -> entry
    byElement: new Map(), // element -> entry
    quick: [],       // local fixes
    notes: [],       // report-only findings
    applied: [],     // changes applied, in order
    originals: new Map(), // el -> Map(prop -> [value, priority]) and "__text"
    pins: [],
    showingAfter: true,
    aiSummary: "",
    postScan: null,
    reviewSummary: "",
    reviewNeedsAttention: false,
    aiUsage: { input: 0, output: 0, calls: 0, available: true },
    tokens: null,
    hasKey: false,
    provider: "anthropic",
    designSkills: globalThis.REDLINE_DESIGN_SKILLS || [],
    activeDesignSkill: "balanced",
    includeMobile: true,
    mobileBase: new Map(),
    mobileActive: false,
    mobilePreset: "iphone-390",
    clippedText: 0,
  };

  // ---------------------------------------------------------------- color utils
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const colorCache = new Map();

  function parseColor(str) {
    if (!str) return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    const m = str.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      out = {
        r: +p[0], g: +p[1], b: +p[2],
        a: p[3] === undefined ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : +p[3],
      };
    } else {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#010203";
      cx.fillStyle = str;
      if (cx.fillStyle === "#010203" && str.toLowerCase() !== "#010203") {
        colorCache.set(str, null);
        return null;
      }
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    colorCache.set(str, out);
    return out;
  }
  const blend = (top, base) => ({
    r: top.r * top.a + base.r * (1 - top.a),
    g: top.g * top.a + base.g * (1 - top.a),
    b: top.b * top.a + base.b * (1 - top.a),
    a: 1,
  });
  function lum({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const toHex = (str) => { const c = parseColor(str); return c && c.a > 0 ? hex(c) : "transparent"; };

  // ---------------------------------------------------------------- scanning
  let bgCache = new WeakMap();
  function effectiveBg(el, styleOverrides = null) {
    if (!styleOverrides && bgCache.has(el)) return bgCache.get(el);
    const layers = [];
    let n = el;
    let unknown = false;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") { unknown = true; break; }
      const override = styleOverrides?.get(n)?.["background-color"];
      const c = parseColor(override || cs.backgroundColor);
      if (override && !c) { unknown = true; break; }
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
      n = n.parentElement;
    }
    let out = null;
    if (!unknown) {
      out = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
    }
    if (!styleOverrides) bgCache.set(el, out);
    return out;
  }

  function docRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  }

  function scan() {
    bgCache = new WeakMap();
    state.entries = [];
    state.byId.clear();
    state.byElement.clear();
    const all = document.body ? document.body.querySelectorAll("*") : [];
    const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "BR", "WBR"]);
    const maxY = Math.min(document.documentElement.scrollHeight, 14000);
    let id = 0;
    for (let i = 0; i < all.length && i < MAX_SCAN; i++) {
      const el = all[i];
      if (skipTags.has(el.tagName) || el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const y = r.top + scrollY;
      if (y > maxY) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity < 0.05) continue;
      const text = ownText(el);
      const entry = {
        id: id++, el, cs, text,
        leaf: el.children.length === 0,
        rect: { x: r.left + scrollX, y, w: r.width, h: r.height },
      };
      state.entries.push(entry);
      state.byId.set(entry.id, entry);
      state.byElement.set(el, entry);
    }
  }

  // ---------------------------------------------------------------- local audit
  const PROSE = new Set(["P", "LI", "DD", "DT", "TD", "BLOCKQUOTE", "FIGCAPTION", "LABEL", "SPAN", "DIV", "ARTICLE", "SECTION"]);
  const BUTTONISH = 'button, input[type=submit], input[type=button], [role=button], a';

  function audit() {
    const fixes = [];
    const notes = [];
    const sizes = new Set();
    let missingAlt = 0;
    let clippedText = 0;
    const headings = [];

    for (const e of state.entries) {
      const { el, cs, text, rect } = e;
      const fs = parseFloat(cs.fontSize);
      if (text.length > 1) sizes.add(Math.round(fs));
      const hasTextContent = (el.textContent || "").trim().length > 1;
      const clipsVertically = /^(hidden|clip)$/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
      const clipsHorizontally = /^(hidden|clip)$/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
      if (hasTextContent && (clipsVertically || clipsHorizontally)) clippedText++;
      if (el.tagName === "IMG" && !el.hasAttribute("alt")) missingAlt++;
      if (/^H[1-6]$/.test(el.tagName)) headings.push(+el.tagName[1]);

      // Contrast
      if (text.length > 1 && cs.webkitTextFillColor !== "rgba(0, 0, 0, 0)" && !/text/.test(cs.backgroundClip || cs.webkitBackgroundClip || "")) {
        const bg = effectiveBg(el);
        let fg = parseColor(cs.color);
        if (bg && fg && fg.a > 0.05) {
          if (fg.a < 1) fg = blend(fg, bg);
          const bold = +cs.fontWeight >= 700;
          const large = fs >= 24 || (fs >= 18.66 && bold);
          const need = large ? 3 : 4.5;
          const ratio = contrast(fg, bg);
          if (ratio < need) {
            const target = lum(bg) > 0.35 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
            let fixed = fg;
            for (let t = 0.05; t <= 1.001; t += 0.05) {
              fixed = mix(fg, target, t);
              if (contrast(fixed, bg) >= need + 0.15) break;
            }
            fixes.push({
              el, role: "contrast",
              styles: { color: hex(fixed) },
              reason: `Text was hard to read (${ratio.toFixed(1)}:1 contrast, needs ${need}:1). Adjusted to ${contrast(fixed, bg).toFixed(1)}:1.`,
            });
          }
        }
      }

      // Body text size and line height
      if (PROSE.has(el.tagName) && text.length > 60) {
        const styles = {};
        const why = [];
        if (fs < 15) { styles["font-size"] = "16px"; why.push(`body text was ${Math.round(fs)}px, small for comfortable reading`); }
        const lhPx = cs.lineHeight === "normal" ? fs * 1.2 : parseFloat(cs.lineHeight);
        const lh = lhPx / fs;
        const multiline = rect.h >= lhPx * 1.8;
        if (multiline && lh < 1.35) { styles["line-height"] = "1.55"; why.push("lines were packed tightly"); }
        if (why.length) {
          fixes.push({ el, role: "type", styles, reason: cap(why.join(" and ")) + "." });
        }
        // Line length
        const align = cs.textAlign;
        if (text.length > 200 && rect.w / fs > 42 && (align === "start" || align === "left")) {
          fixes.push({ el, role: "spacing", styles: { "max-width": "68ch" }, reason: `Lines ran to about ${Math.round(rect.w / fs * 2)} characters. Capped them near 68 so the eye can track back.` });
        }
      }

      // Small tap targets on button-like controls
      if (el.matches(BUTTONISH) && text.length > 0 && text.length < 32 && cs.display !== "inline") {
        const looksLikeButton = el.tagName !== "A" || parseColor(cs.backgroundColor)?.a > 0 || parseFloat(cs.borderTopWidth) > 0;
        if (looksLikeButton && rect.h < 34 && rect.w < 320) {
          const add = Math.ceil((40 - rect.h) / 2);
          fixes.push({
            el, role: "spacing",
            styles: {
              "padding-top": `${parseFloat(cs.paddingTop) + add}px`,
              "padding-bottom": `${parseFloat(cs.paddingBottom) + add}px`,
            },
            reason: `This control was only ${Math.round(rect.h)}px tall. Grew it to about 40px so it's easier to tap.`,
          });
        }
      }
    }

    if (sizes.size > 8) notes.push(`${sizes.size} different text sizes are in use. A scale of 5 or 6 usually reads as more deliberate.`);
    if (missingAlt) notes.push(`${missingAlt} image${missingAlt > 1 ? "s have" : " has"} no alt text, so screen readers can't describe ${missingAlt > 1 ? "them" : "it"}.`);
    if (clippedText) notes.push(`${clippedText} text area${clippedText > 1 ? "s appear" : " appears"} clipped by its container. Check the section height, width, and spacing.`);
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) { notes.push(`The heading levels skip (h${headings[i - 1]} then h${headings[i]}), which confuses screen reader navigation.`); break; }
    }
    if (!headings.includes(1)) notes.push("No h1 heading was found on this page.");

    state.quick = fixes.slice(0, 80);
    state.notes = notes;
    state.clippedText = clippedText;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------------------------------------------------------------- AI plan
  function pageSummary({ fullPage = false } = {}) {
    const vh = innerHeight;
    const interesting = state.entries.filter((e) => {
      if (!fullPage && e.rect.y > vh * 4) return false;
      const { el, cs, text, rect } = e;
      if (text.length > 1) return true;
      if (el.matches("a, button, input, select, textarea, img, svg")) return true;
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0 && rect.w * rect.h > 20000) return true;
      if (parseFloat(cs.borderTopWidth) > 0 && rect.w * rect.h > 4000) return true;
      return false;
    }).slice(0, MAX_AI_ELEMENTS);

    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: vh },
      elements: interesting.map((e) => {
        const { cs, rect } = e;
        const o = {
          id: e.id,
          tag: e.el.tagName.toLowerCase(),
          x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h),
          color: toHex(cs.color),
          bg: toHex(cs.backgroundColor),
          fs: cs.fontSize, fw: cs.fontWeight,
          ff: cs.fontFamily.split(",")[0].replace(/["']/g, "").slice(0, 30),
          lh: cs.lineHeight,
          pad: cs.padding,
          display: cs.display,
          flexDirection: cs.flexDirection,
          flexWrap: cs.flexWrap,
          alignItems: cs.alignItems,
          justifyContent: cs.justifyContent,
          gridColumns: cs.gridTemplateColumns.slice(0, 120),
          gap: cs.gap,
          maxWidth: cs.maxWidth,
          parentId: state.byElement.get(e.el.parentElement)?.id ?? null,
          containsEmoji: /\p{Extended_Pictographic}/u.test(e.text),
          usesGradient: /gradient\(/i.test(cs.backgroundImage),
        };
        if (e.text) o.text = e.text.slice(0, 180);
        if (e.leaf && e.text) o.leaf = true;
        if (e.el.children.length) {
          const childIds = [...e.el.children].slice(0, 12).map((child) => state.byElement.get(child)?.id).filter(Number.isInteger);
          if (childIds.length) o.childIds = childIds;
        }
        if (parseFloat(cs.borderRadius)) o.radius = cs.borderRadius;
        if (parseFloat(cs.borderTopWidth)) o.border = `${cs.borderTopWidth} ${toHex(cs.borderTopColor)}`;
        if (cs.boxShadow !== "none") o.shadow = true;
        return o;
      }),
    };
  }

  const SAFE_VALUE = /^[^;{}<>\\]*$/;
  function validatePlan(plan) {
    if (!plan || !Array.isArray(plan.changes)) throw new Error("The AI's plan had no changes in it.");
    const out = [];
    const sanitizeStyles = (raw, allow, entry) => {
      const styles = {};
      const display = getComputedStyle(entry.el).display;
      const parentDisplay = entry.el.parentElement ? getComputedStyle(entry.el.parentElement).display : "";
      const flexContainer = display === "flex" || display === "inline-flex";
      const gridContainer = display === "grid" || display === "inline-grid";
      const flexItem = parentDisplay === "flex" || parentDisplay === "inline-flex";
      const gridItem = parentDisplay === "grid" || parentDisplay === "inline-grid";
      for (const [k, v] of Object.entries(raw || {})) {
        const prop = String(k).toLowerCase().trim();
        const val = String(v).trim();
        if (!allow.has(prop) || !val || val.length >= 140 || !SAFE_VALUE.test(val) || /url\(|expression|javascript:/i.test(val)) continue;
        if (!window.CSS?.supports(prop, val)) continue;
        if (prop.startsWith("grid-") && !gridContainer) continue;
        if (["flex-direction", "flex-wrap"].includes(prop) && !flexContainer) continue;
        if (["flex-grow", "flex-shrink", "flex-basis"].includes(prop) && !flexItem) continue;
        if (["gap", "row-gap", "column-gap", "align-items", "justify-content"].includes(prop) && !flexContainer && !gridContainer) continue;
        if (["align-self", "justify-self"].includes(prop) && !flexItem && !gridItem) continue;
        if (prop === "flex-direction" && !new Set(["row", "column"]).has(val.toLowerCase())) continue;
        if (prop === "flex-wrap" && !new Set(["wrap", "nowrap"]).has(val.toLowerCase())) continue;
        if (prop === "grid-auto-flow" && !new Set(["row", "column", "dense", "row dense", "column dense"]).has(val.toLowerCase())) continue;
        if (prop === "font-size") {
          const m = val.match(/^([\d.]+)(px|pt|rem|em)$/i);
          if (!m) continue;
          const n = +m[1];
          const parentPx = entry.el.parentElement ? parseFloat(getComputedStyle(entry.el.parentElement).fontSize) : 16;
          const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
          const px = m[2].toLowerCase() === "px" ? n
            : m[2].toLowerCase() === "pt" ? n * 96 / 72
            : m[2].toLowerCase() === "rem" ? n * rootPx
            : n * parentPx;
          if (px < 12 || px > 96) continue;
        }
        if (prop === "line-height") {
          const m = val.match(/^([\d.]+)(px)?$/i);
          if (m && ((!m[2] && +m[1] < 1) || (m[2] && +m[1] < 14))) continue;
        }
        if (["width", "max-width"].includes(prop) && entry.el.textContent.trim()) {
          const m = val.match(/^([\d.]+)(px|rem|em|%)?$/i);
          if (m) {
            const amount = +m[1];
            const unit = (m[2] || "px").toLowerCase();
            if ((unit === "px" && amount < 80) || ((unit === "rem" || unit === "em") && amount < 5) || (unit === "%" && amount < 10)) continue;
          }
        }
        if (["height", "max-height"].includes(prop) && entry.el.textContent.trim()) {
          const m = val.match(/^([\d.]+)(px|rem|em)?$/i);
          if (m) {
            const amount = +m[1];
            const unit = (m[2] || "px").toLowerCase();
            const px = unit === "px" ? amount : amount * 16;
            if (px < (prop === "height" ? 40 : 80)) continue;
          }
        }
        styles[prop] = val;
      }
      return styles;
    };
    for (const c of plan.changes.slice(0, 24)) {
      const entry = state.byId.get(+c.id);
      if (!entry || !entry.el.isConnected) continue;
      const styles = sanitizeStyles(c.styles, ALLOWED, entry);
      const mobileStyles = state.includeMobile ? sanitizeStyles(c.mobileStyles, MOBILE_ALLOWED, entry) : {};
      let text = null;
      if (typeof c.text === "string" && c.text.trim() && entry.leaf && c.text.length < 241) {
        const desired = c.text.trim();
        const current = (entry.el.textContent || "").replace(/\s+/g, " ").trim();
        if (desired.replace(/\s+/g, " ") !== current) text = desired;
      }
      if (!Object.keys(styles).length && !Object.keys(mobileStyles).length && !text) continue;
      const role = ROLES[c.role] ? c.role : text ? "copy" : "color";
      out.push({ el: entry.el, role, styles, mobileStyles, text, reason: String(c.reason || "").slice(0, 200) });
    }
    if (!out.length) throw new Error("None of the AI's changes could be applied to this page.");

    // Prevent a redesign from making text disappear. Reject planned foreground/background colors
    // that fail contrast checks, and preserve page colors where an image or gradient is unsampleable.
    const styleOverrides = new Map();
    for (const change of out) {
      const combined = styleOverrides.get(change.el) || {};
      Object.assign(combined, change.styles);
      styleOverrides.set(change.el, combined);
    }
    const removePlannedStyle = (el, prop) => {
      for (const change of out) if (change.el === el) delete change.styles[prop];
      const combined = styleOverrides.get(el);
      if (combined) delete combined[prop];
    };
    for (const entry of state.entries) {
      const el = entry.el;
      if (!entry.text.trim()) continue;
      let colorSource = null;
      const bgSources = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const styles = styleOverrides.get(n);
        if (!colorSource && styles && Object.prototype.hasOwnProperty.call(styles, "color")) colorSource = n;
        if (styles && Object.prototype.hasOwnProperty.call(styles, "background-color")) bgSources.push(n);
      }
      if (!colorSource && !bgSources.length) continue;

      const bg = effectiveBg(el, styleOverrides);
      const rawColor = colorSource
        ? styleOverrides.get(colorSource).color
        : getComputedStyle(el).color;
      const fg = parseColor(rawColor);
      if (!bg || !fg) {
        if (colorSource) removePlannedStyle(colorSource, "color");
        for (const source of bgSources) removePlannedStyle(source, "background-color");
        continue;
      }
      const visibleFg = fg.a < 1 ? blend(fg, bg) : fg;
      if (contrast(visibleFg, bg) < 4.5) {
        if (colorSource) removePlannedStyle(colorSource, "color");
        for (const source of bgSources) removePlannedStyle(source, "background-color");
      }
    }
    return out.filter((change) =>
      Object.keys(change.styles).length ||
      Object.keys(change.mobileStyles).length ||
      change.text != null
    );
  }

  // ---------------------------------------------------------------- apply / restore
  function track(el) {
    if (!state.originals.has(el)) state.originals.set(el, new Map([["__hadStyle", el.hasAttribute("style")]]));
    return state.originals.get(el);
  }
  function remember(el, prop) {
    const m = track(el);
    if (!m.has(prop)) {
      m.set(prop, prop === "__text" ? el.textContent : [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    }
  }

  function writeChange(c) {
    for (const [p, v] of Object.entries(c.styles)) {
      remember(c.el, p);
      c.el.style.setProperty(p, v, "important");
    }
    if (c.text != null) { remember(c.el, "__text"); c.el.textContent = c.text; }
  }

  function restoreAll() {
    restoreMobileOverrides();
    state.mobileBase.clear();
    state.mobileActive = false;
    for (const el of [...transitions.keys()]) endTransition(el, true);
    for (const [el, m] of state.originals) {
      for (const [p, v] of m) {
        if (p === "__text" || p === "__hadStyle") { if (p === "__text") el.textContent = v; continue; }
        if (v[0]) el.style.setProperty(p, v[0], v[1]);
        else el.style.removeProperty(p);
      }
      if (!m.get("__hadStyle") && el.getAttribute("style") === "") el.removeAttribute("style");
    }
  }

  function reapplyAll() {
    for (const c of state.applied) {
      for (const [p, v] of Object.entries(c.styles)) c.el.style.setProperty(p, v, "important");
      if (c.text != null) c.el.textContent = c.text;
    }
    syncMobileStyles();
  }

  function restoreMobileOverrides() {
    for (const [el, props] of state.mobileBase) {
      for (const [prop, value] of props) {
        if (value[0]) el.style.setProperty(prop, value[0], value[1]);
        else el.style.removeProperty(prop);
      }
    }
  }

  function syncMobileStyles() {
    if (state.mobileActive) {
      const desktopByEl = new Map();
      for (const change of state.applied) {
        const styles = desktopByEl.get(change.el) || {};
        Object.assign(styles, change.styles);
        desktopByEl.set(change.el, styles);
      }
      for (const [el, props] of state.mobileBase) {
        const desktop = desktopByEl.get(el) || {};
        for (const prop of props.keys()) {
          if (Object.prototype.hasOwnProperty.call(desktop, prop)) props.set(prop, [desktop[prop], "important"]);
        }
      }
      restoreMobileOverrides();
      state.mobileActive = false;
    }
    const byEl = new Map();
    for (const change of state.applied) {
      const styles = change.mobileStyles || {};
      if (!Object.keys(styles).length) continue;
      const merged = byEl.get(change.el) || {};
      Object.assign(merged, styles);
      byEl.set(change.el, merged);
    }
    if (innerWidth > 640) return;
    for (const [el, styles] of byEl) {
      if (!state.mobileBase.has(el)) state.mobileBase.set(el, new Map());
      const base = state.mobileBase.get(el);
      for (const [prop, value] of Object.entries(styles)) {
        if (!base.has(prop)) base.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
        el.style.setProperty(prop, value, "important");
      }
    }
    state.mobileActive = byEl.size > 0;
  }

  // Temporary transitions, reference-counted so overlapping edits on one element don't clobber each other.
  const transitions = new Map(); // el -> { prev: [value, priority], count }
  function beginTransition(el) {
    if (reducedMotion) return;
    let t = transitions.get(el);
    if (!t) {
      t = { prev: [el.style.getPropertyValue("transition"), el.style.getPropertyPriority("transition")], count: 0 };
      transitions.set(el, t);
      el.style.setProperty("transition", "color .45s, background-color .45s, font-size .45s, width .45s, max-width .45s, padding .45s, gap .45s, grid-template-columns .45s, border-radius .45s, box-shadow .45s, line-height .45s", "important");
    }
    t.count++;
  }
  function endTransition(el, force) {
    const t = transitions.get(el);
    if (!t || (--t.count > 0 && !force)) return;
    if (t.prev[0]) el.style.setProperty("transition", t.prev[0], t.prev[1]);
    else el.style.removeProperty("transition");
    transitions.delete(el);
  }

  async function animateWrite(c) {
    const el = c.el;
    track(el);
    beginTransition(el);
    for (const [p, v] of Object.entries(c.styles)) { remember(el, p); el.style.setProperty(p, v, "important"); }
    if (c.text != null) await typeText(c);
    setTimeout(() => endTransition(el), 600);
  }

  async function typeText(c) {
    remember(c.el, "__text");
    const from = c.el.textContent;
    if (state.skip || reducedMotion) { c.el.textContent = c.text; return; }
    for (let i = from.length; i >= 0; i -= Math.max(1, Math.ceil(from.length / 12))) {
      c.el.textContent = from.slice(0, i);
      await wait(T(28));
    }
    for (let i = 1; i <= c.text.length; i++) {
      c.el.textContent = c.text.slice(0, i);
      await wait(T(45));
    }
  }

  // ---------------------------------------------------------------- overlay
  const host = document.createElement("redline-overlay");
  host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;overflow:clip;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #20242b; }

    .sel { position: absolute; border: 1.5px solid var(--c); border-radius: 2px; opacity: 0; transform: scale(1.03);
      transition: opacity .18s, transform .18s, left .45s, top .45s, width .45s, height .45s; }
    .sel.on { opacity: 1; transform: none; }
    .sel i { position: absolute; width: 7px; height: 7px; background: #fff; border: 1.5px solid var(--c); }
    .sel i:nth-child(1) { left: -4px; top: -4px; } .sel i:nth-child(2) { right: -4px; top: -4px; }
    .sel i:nth-child(3) { left: -4px; bottom: -4px; } .sel i:nth-child(4) { right: -4px; bottom: -4px; }
    .sel.flash { box-shadow: 0 0 0 6px color-mix(in srgb, var(--c) 25%, transparent); }

    .chip { position: absolute; background: #fff; border: 1.5px solid var(--c); border-radius: 8px;
      padding: 6px 9px; box-shadow: 0 6px 18px rgba(20,24,32,.16); white-space: nowrap; opacity: 0;
      transform: translateY(4px); transition: opacity .18s, transform .18s; font-size: 12px; }
    .chip.on { opacity: 1; transform: none; }
    .chip .row { display: flex; gap: 6px; align-items: center; }
    .chip .prop { color: #5c6470; }
    .chip .old { text-decoration: line-through; text-decoration-color: var(--c); color: #8a919c; }
    .chip .new { font-weight: 600; }
    .chip .sw { width: 11px; height: 11px; border-radius: 3px; border: 1px solid rgba(0,0,0,.2); display: inline-block; vertical-align: -1px; margin-right: 3px; }

    .cur { position: absolute; left: 0; top: 0; will-change: transform; transition: transform .6s cubic-bezier(.3,.7,.2,1); }
    .cur svg { display: block; filter: drop-shadow(0 2px 3px rgba(0,0,0,.25)); }
    .cur .tag { position: absolute; left: 16px; top: 18px; background: var(--c); color: #fff; font-size: 11px; font-weight: 600;
      padding: 2px 7px; border-radius: 9px 9px 9px 2px; white-space: nowrap; }
    .cur .ring { position: absolute; left: -10px; top: -10px; width: 20px; height: 20px; border-radius: 50%;
      border: 2px solid var(--c); opacity: 0; }
    .cur .ring.go { animation: ring .45s ease-out; }
    @keyframes ring { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.8); opacity: 0; } }

    .pin { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50% 50% 50% 0;
      background: var(--c); color: #fff; font-size: 10.5px; font-weight: 700; display: grid; place-items: center;
      pointer-events: auto; cursor: help; box-shadow: 0 2px 5px rgba(0,0,0,.25); animation: drop .3s ease-out; }
    .pins-off .pin { display: none; }
    @keyframes drop { from { transform: translateY(-8px) scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
    .pin .tip { display: none; position: absolute; left: 24px; top: -4px; width: 250px; background: #20242b; color: #f3f4f6;
      font-weight: 400; font-size: 12px; line-height: 1.45; padding: 8px 10px; border-radius: 8px; text-align: left; }
    .pin:hover .tip, .pin:focus .tip { display: block; }
    .pin .tip b { color: #fff; }

    .panel { position: fixed; right: 18px; bottom: 18px; width: 320px; max-width: calc(100vw - 36px);
      max-height: calc(100vh - 36px); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
      background: #fff; color: #20242b; border: 1px solid #d5d9e0; border-radius: 12px;
      box-shadow: 0 14px 40px rgba(20,24,32,.22); padding: 14px 14px 12px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .panel h2 { margin: -2px -2px 0; padding: 2px; font-size: 15px; font-weight: 700; display: flex; align-items: center; justify-content: space-between;
      cursor: grab; user-select: none; touch-action: none; }
    .panel h2.dragging { cursor: grabbing; }
    .panel h2 span { text-decoration: underline wavy #e5254b; text-underline-offset: 4px; text-decoration-thickness: 1.5px; }
    .panel .x { background: none; border: 0; font-size: 18px; line-height: 1; color: #5c6470; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
    .panel p { margin: 8px 0 0; color: #3b414b; }
    .panel .muted { color: #5c6470; font-size: 12px; }
    .panel .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .panel .btns.compact { gap: 5px; margin-top: 8px; }
    .panel .result-meta { font-size: 12px; color: #5c6470; }
    .panel .result-meta span { font-weight: 400; }
    .panel .run-report, .panel .redesign-options { margin-top: 8px; padding-top: 1px; }
    .panel .run-report summary, .panel .redesign-options summary { list-style: none; display: flex; align-items: center; gap: 6px; width: fit-content;
      padding: 4px 0; font-size: 11.5px; font-weight: 600; }
    .panel .run-report summary::-webkit-details-marker, .panel .redesign-options summary::-webkit-details-marker { display: none; }
    .panel .run-report summary::before, .panel .redesign-options summary::before { content: "›"; display: inline-block; font-size: 16px; line-height: 12px; transition: transform .15s; }
    .panel .run-report[open] summary::before, .panel .redesign-options[open] summary::before { transform: rotate(90deg); }
    .panel .report-content { padding-top: 2px; }
    .panel .report-content p:first-child { margin-top: 4px; }
    .panel .device-select { min-width: 0; flex: 1 1 180px; font: inherit; font-size: 12px; padding: 7px 9px; border: 1px solid #d5d9e0; border-radius: 7px; color: #20242b; background: #f6f7f9; }
    .panel button.b { font: inherit; font-weight: 600; font-size: 12.5px; padding: 7px 11px; border-radius: 7px; cursor: pointer;
      border: 1px solid #d5d9e0; background: #fff; color: #20242b; }
    .panel button.b.primary { background: #e5254b; border-color: #e5254b; color: #fff; }
    .panel button.b:disabled { opacity: .5; cursor: default; }
    .panel button:focus-visible, .panel input:focus-visible { outline: 2px solid #e5254b; outline-offset: 2px; }
    .panel input[type=text] { width: 100%; margin-top: 10px; font: inherit; font-size: 12.5px; padding: 7px 9px;
      border: 1px solid #d5d9e0; border-radius: 7px; color: #20242b; background: #f6f7f9; }
    .panel .skill-select { display: block; margin-top: 10px; color: #5c6470; font-size: 11.5px; font-weight: 600; }
    .panel .skill-select select { display: block; width: 100%; margin-top: 4px; font: inherit; font-weight: 500; font-size: 12.5px; padding: 7px 9px;
      border: 1px solid #d5d9e0; border-radius: 7px; color: #20242b; background: #f6f7f9; }
    .panel .skill-source { display: inline-block; margin-top: 4px; color: #5c6470; font-size: 11px; }
    .panel .mobile-option { display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; padding: 8px; border: 1px solid #d5d9e0; border-radius: 7px; cursor: pointer; }
    .panel .mobile-option input { margin: 2px 0 0; accent-color: #e5254b; }
    .panel .mobile-option b, .panel .mobile-option small { display: block; }
    .panel .mobile-option small { margin-top: 2px; color: #5c6470; font-size: 11px; font-weight: 400; }
    .panel .seg { display: inline-flex; border: 1px solid #d5d9e0; border-radius: 7px; overflow: hidden; }
    .panel .seg button { font: inherit; font-size: 12px; font-weight: 600; border: 0; background: #fff; color: #5c6470; padding: 6px 9px; cursor: pointer; }
    .panel .seg button[aria-pressed=true] { background: #20242b; color: #fff; }
    .panel .bar { height: 4px; background: #eceef2; border-radius: 2px; margin-top: 10px; overflow: hidden; }
    .panel .bar div { height: 100%; width: 0; background: #e5254b; transition: width .3s; }
    .panel details { margin-top: 10px; font-size: 12px; color: #3b414b; }
    .panel details summary { cursor: pointer; color: #5c6470; }
    .panel details ul { margin: 6px 0 0; padding-left: 16px; }
    .panel details li { margin-bottom: 4px; }
    .panel .err { color: #c21a3d; }
    .panel .crew { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
    .panel .crew span { font-size: 11px; font-weight: 600; color: #fff; padding: 1px 7px; border-radius: 9px; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1f2227; color: #e8eaee; border-color: #343840; }
      .panel p { color: #c9cdd4; } .panel .muted, .panel .x, .panel details summary { color: #9aa3ae; }
      .panel details { color: #c9cdd4; }
      .panel button.b, .panel .seg button { background: #262a30; color: #e8eaee; border-color: #343840; }
      .panel .seg { border-color: #343840; }
      .panel .seg button[aria-pressed=true] { background: #e8eaee; color: #1f2227; }
      .panel input[type=text], .panel .skill-select select { background: #16181c; color: #e8eaee; border-color: #343840; }
      .panel .device-select { background: #16181c; color: #e8eaee; border-color: #343840; }
      .panel .result-meta { color: #9aa3ae; }
      .panel .skill-select { color: #9aa3ae; }
      .panel .skill-source { color: #9aa3ae; }
      .panel .mobile-option { border-color: #343840; }
      .panel .mobile-option small { color: #9aa3ae; }
      .panel .bar { background: #343840; } .panel .err { color: #ff6b85; }
    }
    .device-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
      background: rgba(10,14,20,.68); pointer-events: auto; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #20242b; }
    .device-dialog { width: min(620px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 14px;
      border: 1px solid #d5d9e0; border-radius: 14px; background: #f5f6f8; box-shadow: 0 20px 70px rgba(0,0,0,.35); }
    .device-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
    .device-head b { font-size: 14px; }
    .device-controls { display: flex; align-items: center; gap: 8px; }
    .device-controls select, .device-controls button { font: inherit; padding: 7px 9px; border: 1px solid #c9ced6; border-radius: 7px; background: white; color: #20242b; }
    .device-stage { display: grid; place-items: start center; overflow: auto; padding: 12px; min-height: 180px; border-radius: 10px; background: #dfe3e9; }
    .device-frame { overflow: hidden; border: 7px solid #17191d; border-radius: 28px; background: white; box-shadow: 0 8px 28px rgba(0,0,0,.24); }
    .device-frame iframe { display: block; border: 0; background: white; transform-origin: top left; }
    .device-note { margin: 9px 2px 0; color: #59616d; font-size: 11px; }
    @media (prefers-color-scheme: dark) {
      .device-dialog { background: #1f2227; color: #e8eaee; border-color: #343840; }
      .device-controls select, .device-controls button { background: #262a30; color: #e8eaee; border-color: #454a54; }
      .device-stage { background: #111318; } .device-note { color: #9aa3ae; }
    }
  `;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement("style");
    st.textContent = CSS;
    root.appendChild(st);
  }

  const layer = document.createElement("div");
  layer.className = "layer";
  root.appendChild(layer);
  function syncOverlayScroll() {
    layer.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;
  }
  syncOverlayScroll();
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Redline");
  root.appendChild(panel);
  document.documentElement.appendChild(host);

  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------------------------------------------------------------- crew
  const crew = {};
  function cursorFor(role) {
    if (crew[role]) return crew[role];
    const c = h("div", "cur");
    c.style.setProperty("--c", ROLES[role].color);
    c.innerHTML = `<div class="ring"></div>
      <svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1.5 L17.5 11 L10.4 12.2 L13.6 19.4 L10.8 20.6 L7.6 13.4 L2.6 18 Z"
      fill="${ROLES[role].color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <div class="tag">${ROLES[role].name}</div>`;
    layer.appendChild(c);
    const start = panelAnchor();
    const cur = { role, el: c, x: start.x, y: start.y };
    c.style.transition = "none";
    c.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
    crew[role] = cur;
    return cur;
  }
  function panelAnchor() {
    const r = panel.getBoundingClientRect();
    return { x: r.left + scrollX + 20 + Math.random() * 60, y: r.top + scrollY - 10 };
  }

  const T = (ms) => (state.skip ? 0 : ms / state.speed);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function moveTo(cur, x, y) {
    const d = Math.hypot(x - cur.x, y - cur.y);
    const dur = reducedMotion ? 0 : T(Math.min(1100, Math.max(260, d * 0.8)));
    cur.el.style.transition = `transform ${dur}ms cubic-bezier(.3,.7,.2,1)`;
    cur.el.style.transform = `translate(${x}px, ${y}px)`;
    cur.x = x; cur.y = y;
    await wait(dur);
  }
  function click(cur) {
    const ring = cur.el.querySelector(".ring");
    ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go");
  }

  function placeBox(box, r) {
    Object.assign(box.style, { left: `${r.x - 3}px`, top: `${r.y - 3}px`, width: `${r.w + 6}px`, height: `${r.h + 6}px` });
  }

  function diffRows(c) {
    const cs = getComputedStyle(c.el);
    const rows = [];
    for (const [p, v] of Object.entries(c.styles).slice(0, 3)) {
      const before = cs.getPropertyValue(p) || "–";
      const isColor = /color/.test(p);
      const fmt = (val) => isColor ? `<span class="sw" style="background:${esc(val)}"></span>${esc(toHex(val))}` : esc(shorten(val));
      rows.push(`<div class="row"><span class="prop">${esc(p)}</span><span class="old">${fmt(before)}</span><span>→</span><span class="new">${fmt(v)}</span></div>`);
    }
    for (const [p, v] of Object.entries(c.mobileStyles || {}).slice(0, 2)) {
      rows.push(`<div class="row"><span class="prop">Mobile ${esc(p)}</span><span class="new">≤640px: ${esc(shorten(v, 24))}</span></div>`);
    }
    if (c.text != null) rows.push(`<div class="row"><span class="prop">text</span><span class="new">“${esc(shorten(c.text, 34))}”</span></div>`);
    return rows.join("");
  }
  const shorten = (s, n = 22) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

  function addPin(c) {
    const n = state.pins.length + 1;
    const pin = h("div", "pin");
    pin.tabIndex = 0;
    pin.style.setProperty("--c", ROLES[c.role].color);
    const changes = Object.entries(c.styles).map(([p, v]) => `${p}: ${v}`).join("; ");
    const mobileChanges = Object.entries(c.mobileStyles || {}).map(([p, v]) => `mobile ${p}: ${v}`).join("; ");
    const allChanges = [changes, mobileChanges].filter(Boolean).join("; ");
    pin.innerHTML = `${n}<div class="tip"><b>${esc(ROLES[c.role].name)}.</b> ${esc(c.reason || "Updated.")}${allChanges ? `<br><span style="opacity:.7">${esc(allChanges)}</span>` : ""}</div>`;
    layer.appendChild(pin);
    state.pins.push({ pin, el: c.el });
    layoutPin(state.pins[state.pins.length - 1]);
  }
  function layoutPin({ pin, el }) {
    if (!el.isConnected) { pin.style.display = "none"; return; }
    const r = docRect(el);
    const rightEdge = scrollX + innerWidth - 18;
    const preferred = r.x + r.w + 12;
    pin.style.left = `${preferred + 10 <= rightEdge ? preferred : Math.max(scrollX + 18, r.x - 12)}px`;
    pin.style.top = `${Math.max(scrollY + 18, r.y - 12)}px`;
  }
  const layoutPins = () => state.pins.forEach(layoutPin);

  function inView(r) {
    return r.y + Math.min(r.h, 60) > scrollY + 40 && r.y < scrollY + innerHeight - 140;
  }

  async function doTask(c) {
    if (state.skip) { writeChange(c); state.applied.push(c); addPin(c); return; }
    const cur = cursorFor(c.role);
    const color = ROLES[c.role].color;
    let r = docRect(c.el);
    if (state.follow && !inView(r)) {
      scrollTo({ top: Math.max(0, r.y - innerHeight * 0.3), behavior: reducedMotion ? "auto" : "smooth" });
      const deadline = performance.now() + (reducedMotion ? 120 : 1400);
      while (performance.now() < deadline) {
        await wait(60);
        r = docRect(c.el);
        if (inView(r)) break;
      }
      r = docRect(c.el);
    }
    // Point at the element and select it.
    await moveTo(cur, r.x + Math.min(r.w * 0.2, 40), r.y + Math.min(r.h * 0.5, 18));
    if (!alive()) return;
    click(cur);
    const box = h("div", "sel", "<i></i><i></i><i></i><i></i>");
    box.style.setProperty("--c", color);
    placeBox(box, r);
    layer.appendChild(box);
    requestAnimationFrame(() => box.classList.add("on"));

    // Show the change on a chip, above the element when there's room.
    const chip = h("div", "chip", diffRows(c));
    chip.style.setProperty("--c", color);
    layer.appendChild(chip);
    const ch = chip.offsetHeight;
    const above = r.y - scrollY > ch + 24;
    chip.style.left = `${Math.max(scrollX + 8, Math.min(r.x, scrollX + innerWidth - chip.offsetWidth - 12))}px`;
    chip.style.top = `${above ? r.y - ch - 12 : r.y + Math.min(r.h, 400) + 12}px`;
    await wait(T(220));
    chip.classList.add("on");
    await wait(T(420));
    if (!alive()) return cleanup();

    // Move onto the new value and commit it.
    const last = chip.querySelector(".row:last-child .new") || chip;
    const lr = last.getBoundingClientRect();
    await moveTo(cur, lr.left + scrollX + lr.width / 2, lr.top + scrollY + lr.height / 2);
    click(cur);
    await animateWrite(c);
    state.applied.push(c);
    await wait(T(260));
    placeBox(box, docRect(c.el));
    box.classList.add("flash");
    addPin(c);
    layoutPins();
    await wait(T(500));
    cleanup();

    function cleanup() {
      box.classList.remove("on");
      chip.classList.remove("on");
      setTimeout(() => { box.remove(); chip.remove(); }, 220);
    }
  }

  const alive = (token) => state.runToken === (token ?? state.runToken) && host.isConnected;

  async function run(changes, { deferDone = false } = {}) {
    const token = ++state.runToken;
    state.phase = "working";
    state.skip = false;
    const pending = changes.map((c) => ({ c, y: docRect(c.el).y })).sort((a, b) => a.y - b.y);
    const total = pending.length;
    let done = 0;
    state.progress = { total, done };
    render({ total, done });
    const roles = [...new Set(pending.map((p) => p.c.role))];

    const worker = async (role) => {
      while (alive(token)) {
        const mine = pending.findIndex((p) => p.c.role === role);
        if (mine < 0) return;
        const windowEnd = pending[0].y + innerHeight * 0.9;
        if (pending[mine].y > windowEnd && !state.skip) { await wait(120); continue; }
        const [{ c }] = pending.splice(mine, 1);
        if (c.el.isConnected) await doTask(c);
        done++;
        state.progress = { total, done };
        if (alive(token)) render({ total, done });
      }
    };
    await Promise.all(roles.map(worker));
    if (!alive(token)) return;
    syncMobileStyles();
    layoutPins();
    for (const cur of Object.values(crew)) {
      const a = panelAnchor();
      moveTo(cur, a.x, a.y);
    }
    state.phase = deferDone ? "thinking" : "done";
    state.showingAfter = true;
    render(deferDone ? { status: "Checking the redesigned page for clipped text and layout issues…" } : {});
  }

  // Cursors circle the panel while the AI is thinking.
  let orbitRaf = 0;
  function startOrbit() {
    Object.keys(ROLES).forEach(cursorFor);
    const t0 = performance.now();
    const step = (t) => {
      const pr = panel.getBoundingClientRect();
      const cxp = pr.left + scrollX + pr.width / 2;
      const cyp = pr.top + scrollY - 60;
      Object.values(crew).forEach((cur, i, arr) => {
        const a = (t - t0) / 1400 + (i / arr.length) * Math.PI * 2;
        cur.x = cxp + Math.cos(a) * 110;
        cur.y = cyp + Math.sin(a) * 34;
        cur.el.style.transition = "none";
        cur.el.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
      });
      orbitRaf = requestAnimationFrame(step);
    };
    if (!reducedMotion) orbitRaf = requestAnimationFrame(step);
  }
  function stopOrbit() { cancelAnimationFrame(orbitRaf); }

  // ---------------------------------------------------------------- AI flow
  async function screenshot() {
    host.style.visibility = "hidden";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const res = await chrome.runtime.sendMessage({ type: "screenshot" });
      return res?.ok ? res.dataUrl : null;
    } catch { return null; } finally { host.style.visibility = ""; }
  }

  function requestAI(message) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "redline-ai" });
      let settled = false;
      port.onMessage.addListener((response) => {
        if (settled) return;
        settled = true;
        port.disconnect();
        response?.ok ? resolve(response) : reject(new Error(response?.error || "The AI request failed."));
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Lost connection to the extension. Try again."));
      });
      port.postMessage(message);
    });
  }

  function addAIUsage(usage) {
    state.aiUsage.calls++;
    if (!usage || !Number.isFinite(+usage.input) || !Number.isFinite(+usage.output)) {
      state.aiUsage.available = false;
      return;
    }
    state.aiUsage.input += +usage.input;
    state.aiUsage.output += +usage.output;
  }

  async function aiRedesign(brief, skillId, includeMobile) {
    const token = ++state.runToken;
    state.phase = "thinking";
    state.error = "";
    state.postScan = null;
    state.reviewSummary = "";
    state.reviewNeedsAttention = false;
    state.aiUsage = { input: 0, output: 0, calls: 0, available: true };
    render({ status: "Taking a screenshot…" });
    // Scan the page as it is now (including any quick fixes already applied).
    scan();
    const page = pageSummary();
    const shot = await screenshot();
    if (!alive(token)) return;
    render({ status: `Asking ${state.provider === "openai" ? "OpenAI" : "Claude"} for a redesign. This usually takes 20 to 60 seconds.` });
    startOrbit();
    let plan, changes;
    try {
      const response = await requestAI({ type: "redesign", page, screenshot: shot, brief, skillId, includeMobile });
      plan = response.plan;
      addAIUsage(response.usage);
      changes = validatePlan(plan);
    } catch (err) {
      stopOrbit();
      if (!alive(token)) return;
      state.phase = state.applied.length ? "done" : "ready";
      state.error = err.message;
      render();
      return;
    }
    stopOrbit();
    if (!alive(token)) return;
    state.aiSummary = String(plan.summary || "").slice(0, 300);
    state.tokens = plan.tokens || null;
    const pass = run(changes, { deferDone: true });
    const passToken = state.runToken; // run() claims a new token synchronously
    await pass;
    if (state.runToken !== passToken || !host.isConnected) return; // cancelled, reset or exited
    // Always rescan the finished DOM before showing the done state. Recheck any contrast
    // regressions against the new backgrounds, then scan once more after those corrections.
    const postRedesignScan = () => {
      scan();
      audit();
      state.postScan = { clippedText: state.clippedText || 0, suggestions: state.quick.length };
    };
    postRedesignScan();
    const recheck = state.quick.filter((f) => f.role === "contrast");
    if (recheck.length && host.isConnected) {
      recheck.forEach((f) => (f.reason = "Re-checked after the redesign. " + f.reason));
      const checkPass = run(recheck, { deferDone: true });
      const checkToken = state.runToken;
      await checkPass;
      if (state.runToken !== checkToken || !host.isConnected) return;
      postRedesignScan();
    }

    // Have the same provider inspect the updated page. It can suggest small repairs;
    // allow at most two animated repair passes to prevent an endless redesign loop.
    for (let reviewRound = 0; reviewRound < 3 && host.isConnected; reviewRound++) {
      const reviewToken = state.runToken;
      state.phase = "thinking";
      render({ status: `Rescanning and asking ${state.provider === "openai" ? "OpenAI" : "Claude"} to review the updated page…` });
      scan();
      const reviewPage = pageSummary({ fullPage: true });
      const reviewShot = await screenshot();
      if (!alive(reviewToken)) return;
      try {
        const response = await requestAI({ type: "review", page: reviewPage, screenshot: reviewShot, brief, skillId, includeMobile });
        if (!alive(reviewToken)) return;
        addAIUsage(response.usage);
        const reviewPlan = response.plan || {};
        state.reviewSummary = String(reviewPlan.summary || (reviewPlan.ok ? "The updated page passed the AI review." : "The review found issues worth checking.")).slice(0, 300);
        const needsRepair = reviewPlan.ok === false && Array.isArray(reviewPlan.changes) && reviewPlan.changes.length > 0;
        if (!needsRepair) {
          state.reviewNeedsAttention = reviewPlan.ok === false;
          break;
        }
        if (reviewRound >= 2) {
          state.reviewNeedsAttention = true;
          state.reviewSummary += " Further changes were not applied; inspect the result before exporting.";
          break;
        }
        const repairs = validatePlan(reviewPlan);
        if (!repairs.length) {
          state.reviewNeedsAttention = true;
          state.reviewSummary += " No safe repair could be applied automatically.";
          break;
        }
        const repairPass = run(repairs, { deferDone: true });
        const repairToken = state.runToken;
        await repairPass;
        if (state.runToken !== repairToken || !host.isConnected) return;
        postRedesignScan();
      } catch (error) {
        state.reviewNeedsAttention = true;
        state.reviewSummary = `AI review did not finish: ${String(error?.message || error).slice(0, 220)}`;
        break;
      }
    }
    state.phase = "done";
    state.showingAfter = true;
    render();
  }

  // ---------------------------------------------------------------- panel
  function render(extra = {}) {
    const p = state.phase;
    const crewTags = (roles) => `<div class="crew">${roles.map((r) => `<span style="background:${ROLES[r].color}">${ROLES[r].name}</span>`).join("")}</div>`;
    let body = "";

    if (p === "ready") {
      const n = state.quick.length;
      const roles = [...new Set(state.quick.map((q) => q.role))];
      body = `<p>${n ? `Found <b>${n}</b> fixable issue${n > 1 ? "s" : ""} on this page.` : "No quick fixes needed on this page."}</p>
        ${n ? crewTags(roles) : ""}
        ${notesHtml()}
        ${designSkillControl()}
        ${mobileLayoutControl()}
        <input type="text" id="brief" placeholder="Direction for the AI (optional), e.g. calmer and more premium" aria-label="Direction for the AI redesign">
        <div class="btns">
          ${n ? `<button class="b primary" data-act="quick">Fix ${n} issue${n > 1 ? "s" : ""}</button>` : ""}
          ${state.hasKey ? `<button class="b ${n ? "" : "primary"}" data-act="ai">Redesign with AI</button>` : `<button class="b" data-act="options">Connect AI for redesigns</button>`}
        </div>`;
    } else if (p === "thinking") {
      body = `<p>${esc(extra.status || "Working…")}</p><div class="btns"><button class="b" data-act="cancel">Cancel</button></div>`;
    } else if (p === "working") {
      const { total = state.progress?.total || 1, done = state.progress?.done || 0 } = extra;
      body = `${state.aiSummary ? `<p>${esc(state.aiSummary)}</p>` : ""}
        <p class="muted">Applied ${done} of ${total} changes.</p>
        <div class="bar"><div style="width:${(done / total) * 100}%"></div></div>
        <div class="btns">${speedSeg()}<button class="b ${state.follow ? "primary" : ""}" data-act="follow" aria-pressed="${state.follow}">Auto-scroll ${state.follow ? "on" : "off"}</button><button class="b" data-act="skip">Skip to end</button></div>`;
    } else if (p === "done") {
      const n = state.applied.length;
      const mobileRules = state.applied.reduce((total, change) => total + Object.keys(change.mobileStyles || {}).length, 0);
      const tokenTotal = state.aiUsage.input + state.aiUsage.output;
      const resultMeta = `${n} change${n === 1 ? "" : "s"} applied${state.aiUsage.calls && state.aiUsage.available ? ` · ${tokenTotal.toLocaleString()} tokens` : ""}${state.reviewSummary ? (state.reviewNeedsAttention ? " · Review needs attention" : " · AI checked") : ""}`;
      body = `<p class="result-meta"><b>${resultMeta}</b> <span>Hover a pin to see why.</span></p>
        <details class="run-report"><summary>Review and scan details</summary><div class="report-content">
          ${state.aiSummary ? `<p>${esc(state.aiSummary)}</p>` : ""}
          ${state.postScan ? `<p class="muted">Post-redesign scan: ${state.postScan.clippedText ? `${state.postScan.clippedText} text area${state.postScan.clippedText === 1 ? " may" : "s may"} be clipped. ` : "No clipped text detected. "}${state.postScan.suggestions ? `${state.postScan.suggestions} other readability or layout improvement${state.postScan.suggestions === 1 ? "" : "s"} found.` : "No other quick fixes found."}</p>` : ""}
          ${state.reviewSummary ? `<p class="${state.reviewNeedsAttention ? "err" : "muted"}">AI review: ${esc(state.reviewSummary)}</p>` : ""}
          ${state.aiUsage.calls ? `<p class="muted">AI usage: ${state.aiUsage.available ? `${tokenTotal.toLocaleString()} tokens (${state.aiUsage.input.toLocaleString()} input, ${state.aiUsage.output.toLocaleString()} output across ${state.aiUsage.calls} calls)` : "provider did not return token counts"}.</p>` : ""}
          ${mobileRules ? `<p class="muted">${mobileRules} responsive layout rule${mobileRules === 1 ? "" : "s"} added for screens 640px wide and below.</p>` : ""}
        </div></details>
        ${mobileDeviceControl()}
        <div class="btns compact">
          <div class="seg" role="group" aria-label="Compare">
            <button data-act="before" aria-pressed="${!state.showingAfter}">Before</button>
            <button data-act="after" aria-pressed="${state.showingAfter}">After</button>
          </div>
          <button class="b" data-act="pins">${layer.classList.contains("pins-off") ? "Show pins" : "Hide pins"}</button>
        </div>
        <div class="btns compact export-actions"><button class="b primary" data-act="export">Export CSS</button><button class="b" data-act="png">Full-page PNG</button><button class="b" data-act="prompt" aria-label="Copy implementation brief">Copy brief</button></div>
        ${state.applied.length && window.__redlineRebuild?.restart ? `<div class="btns compact"><button class="b primary" data-act="rebuild">Replay updated page</button></div>` : ""}
        ${state.hasKey ? `<details class="redesign-options"><summary>Redesign options</summary>${designSkillControl()}${mobileLayoutControl()}<input type="text" id="brief" placeholder="Direction for the AI (optional)" aria-label="Direction for the AI redesign"></details>
        <div class="btns compact"><button class="b" data-act="ai">${state.aiSummary ? "Redesign again" : "Redesign with AI"}</button><button class="b" data-act="reset">Undo all</button></div>`
        : `<div class="btns"><button class="b" data-act="options">Connect AI for redesigns</button><button class="b" data-act="reset">Undo all</button></div>`}
        ${extra.flash ? `<p class="muted">${esc(extra.flash)}</p>` : ""}`;
    }
    if (state.error) body += `<p class="err">${esc(state.error)}</p>`;
    panel.innerHTML = `<h2 class="panel-drag-handle" title="Drag to move Redline"><span>Redline</span><button class="x" data-act="exit" aria-label="Exit Redline and restore the page">×</button></h2>${body}`;
  }

  function designSkillControl() {
    if (!state.designSkills.length) return "";
    const active = state.designSkills.find((skill) => skill.id === state.activeDesignSkill) || state.designSkills.find((skill) => skill.id === "balanced");
    const selected = active?.id || "balanced";
    const source = active?.sourceUrl && /^https:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(active.sourceUrl)
      ? `<a class="skill-source" href="${esc(active.sourceUrl)}" target="_blank" rel="noopener noreferrer">View skill source (.md)</a>`
      : "";
    return `<label class="skill-select"><span>Design skill</span><select id="design-skill" aria-label="Choose a design skill">${state.designSkills.map((skill) =>
      `<option value="${esc(skill.id)}" ${skill.id === selected ? "selected" : ""}>${esc(skill.name)}</option>`
    ).join("")}</select></label>${source}`;
  }

  function mobileLayoutControl() {
    return `<label class="mobile-option"><input id="include-mobile" type="checkbox" ${state.includeMobile ? "checked" : ""}><span><b>Also design mobile layout</b><small>Generate responsive CSS for screens 640px and below</small></span></label>`;
  }

  const PHONE_PRESETS = [
    { id: "compact-320", name: "Compact phone", width: 320, height: 640 },
    { id: "android-360", name: "Android compact", width: 360, height: 800 },
    { id: "iphone-se-375", name: "iPhone compact", width: 375, height: 667 },
    { id: "iphone-390", name: "Standard phone", width: 390, height: 844 },
    { id: "android-412", name: "Android large", width: 412, height: 915 },
    { id: "large-430", name: "Large phone", width: 430, height: 932 },
  ];

  function mobileDeviceControl() {
    return `<div class="btns"><select class="device-select" id="mobile-device" aria-label="Choose phone preview size">${PHONE_PRESETS.map((device) =>
      `<option value="${device.id}" ${device.id === state.mobilePreset ? "selected" : ""}>${device.name} · ${device.width} × ${device.height}</option>`
    ).join("")}</select><button class="b" data-act="mobile-preview">Preview phone</button></div>`;
  }

  function openMobilePreview() {
    closeMobilePreview();
    const preset = PHONE_PRESETS.find((device) => device.id === state.mobilePreset) || PHONE_PRESETS[3];
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("redline-overlay, script, noscript").forEach((el) => el.remove());
    clone.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
    const pathFromRoot = (el) => {
      const path = [];
      for (let node = el; node && node !== document.documentElement; node = node.parentNode) {
        if (!node.parentNode) return null;
        path.push([...node.parentNode.childNodes].indexOf(node));
      }
      return path.reverse();
    };
    for (const change of state.applied) {
      const path = pathFromRoot(change.el);
      let target = clone;
      for (const index of path || []) target = target?.childNodes[index];
      if (!target || target.nodeType !== 1) continue;
      for (const [property, value] of Object.entries(change.mobileStyles || {})) {
        target.style.setProperty(property, value, "important");
      }
    }
    const head = clone.querySelector("head");
    if (head) {
      const base = document.createElement("base");
      base.href = location.href;
      head.prepend(base);
    }

    const backdrop = h("div", "device-backdrop");
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-label", "Mobile layout preview");
    backdrop.setAttribute("aria-modal", "true");
    const dialog = h("div", "device-dialog");
    const header = h("div", "device-head");
    const title = h("b");
    title.textContent = "Mobile preview";
    const controls = h("div", "device-controls");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Phone screen size");
    select.innerHTML = PHONE_PRESETS.map((device) => `<option value="${device.id}" ${device.id === preset.id ? "selected" : ""}>${device.name} · ${device.width} × ${device.height}</option>`).join("");
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    controls.append(select, closeButton);
    header.append(title, controls);
    const stage = h("div", "device-stage");
    const frame = h("div", "device-frame");
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", `${preset.name} preview`);
    iframe.setAttribute("sandbox", "allow-same-origin");
    frame.appendChild(iframe);
    stage.appendChild(frame);
    const note = h("p", "device-note");
    note.textContent = "Static preview at this phone's CSS viewport. Links and forms are disabled; close the preview to return to the live page.";
    dialog.append(header, stage, note);
    backdrop.appendChild(dialog);
    root.appendChild(backdrop);

    const draw = (device) => {
      state.mobilePreset = device.id;
      const maxWidth = Math.min(460, innerWidth - 96);
      const maxHeight = Math.max(240, innerHeight - 190);
      const scale = Math.min(1, maxWidth / device.width, maxHeight / device.height);
      const renderedWidth = Math.round(device.width * scale);
      const renderedHeight = Math.round(device.height * scale);
      frame.style.width = `${renderedWidth}px`;
      frame.style.height = `${renderedHeight}px`;
      iframe.style.width = `${device.width}px`;
      iframe.style.height = `${device.height}px`;
      iframe.style.transform = `scale(${scale})`;
      iframe.setAttribute("title", `${device.name}, ${device.width} by ${device.height} CSS pixel preview`);
    };
    select.addEventListener("change", () => {
      const next = PHONE_PRESETS.find((device) => device.id === select.value) || PHONE_PRESETS[3];
      draw(next);
    });
    const close = () => backdrop.remove();
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
    iframe.addEventListener("load", () => {
      try {
        iframe.contentDocument.addEventListener("click", (event) => event.preventDefault(), true);
        iframe.contentDocument.addEventListener("submit", (event) => event.preventDefault(), true);
      } catch {}
    });
    draw(preset);
    iframe.srcdoc = `<!doctype html>${clone.outerHTML}`;
  }

  function closeMobilePreview() {
    root.querySelector(".device-backdrop")?.remove();
  }

  function notesHtml() {
    if (!state.notes.length) return "";
    return `<details><summary>Also noticed (${state.notes.length})</summary><ul>${state.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`;
  }
  function speedSeg() {
    return `<div class="seg" role="group" aria-label="Speed">${[1, 2, 3].map((s) => `<button data-speed="${s}" aria-pressed="${state.speed === s}">${s}×</button>`).join("")}</div>`;
  }

  let panelDrag = null;
  panel.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".panel-drag-handle");
    if (!handle || e.target.closest("button") || e.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    panelDrag = { pointerId: e.pointerId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    handle.classList.add("dragging");
    panel.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  panel.addEventListener("pointermove", (e) => {
    if (!panelDrag || panelDrag.pointerId !== e.pointerId) return;
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - rect.width - 8, e.clientX - panelDrag.offsetX));
    const top = Math.max(8, Math.min(innerHeight - rect.height - 8, e.clientY - panelDrag.offsetY));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
  const finishPanelDrag = (e) => {
    if (!panelDrag || panelDrag.pointerId !== e.pointerId) return;
    panel.querySelector(".panel-drag-handle")?.classList.remove("dragging");
    panelDrag = null;
  };
  panel.addEventListener("pointerup", finishPanelDrag);
  panel.addEventListener("pointercancel", finishPanelDrag);
  function clampDraggedPanel() {
    if (!panel.style.left || !panel.style.top) return;
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left))}px`;
    panel.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, rect.top))}px`;
  }

  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.speed) {
      state.speed = +b.dataset.speed;
      panel.querySelectorAll("[data-speed]").forEach((x) => x.setAttribute("aria-pressed", x === b));
      return;
    }
    const act = b.dataset.act;
    const brief = panel.querySelector("#brief")?.value.trim() || "";
    const skillId = panel.querySelector("#design-skill")?.value || state.activeDesignSkill;
    const includeMobile = panel.querySelector("#include-mobile")?.checked ?? state.includeMobile;
    state.error = "";
    if (act === "exit") return exit();
    if (act === "quick") return run(state.quick);
    if (act === "ai") {
      if (!state.showingAfter) { reapplyAll(); state.showingAfter = true; }
      state.activeDesignSkill = skillId;
      state.includeMobile = includeMobile;
      chrome.storage.local.set({ activeDesignSkill: skillId }).catch(() => {});
      return aiRedesign(brief, skillId, includeMobile);
    }
    if (act === "options") return chrome.runtime.sendMessage({ type: "openOptions" });
    if (act === "skip") { state.skip = true; return; }
    if (act === "follow") {
      state.follow = !state.follow;
      b.textContent = `Auto-scroll ${state.follow ? "on" : "off"}`;
      b.classList.toggle("primary", state.follow);
      b.setAttribute("aria-pressed", String(state.follow));
      return;
    }
    if (act === "cancel") { state.runToken++; stopOrbit(); state.phase = state.applied.length ? "done" : "ready"; return render(); }
    if (act === "before") { restoreAll(); state.showingAfter = false; layer.classList.add("pins-off"); layoutPins(); return render(); }
    if (act === "after") { reapplyAll(); state.showingAfter = true; layer.classList.remove("pins-off"); layoutPins(); return render(); }
    if (act === "pins") { layer.classList.toggle("pins-off"); return render(); }
    if (act === "export") return exportCSS();
    if (act === "png") return exportPNG();
    if (act === "prompt") return copyPrompt();
    if (act === "mobile-preview") {
      state.mobilePreset = panel.querySelector("#mobile-device")?.value || state.mobilePreset;
      return openMobilePreview();
    }
    if (act === "rebuild" && window.__redlineRebuild?.restart) {
      exit(true);
      window.__redlineRebuild.restart();
      return;
    }
    if (act === "reset") return resetAll();
  });

  // ---------------------------------------------------------------- export
  function selectorFor(el) {
    if (el.id && document.querySelectorAll(`#${CSS_escape(el.id)}`).length === 1) return `#${CSS_escape(el.id)}`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement) {
      if (n.id && document.querySelectorAll(`#${CSS_escape(n.id)}`).length === 1) { parts.unshift(`#${CSS_escape(n.id)}`); break; }
      let part = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter((s) => s.tagName === n.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      parts.unshift(part);
      n = n.parentElement;
    }
    if (parts[0] && !parts[0].startsWith("#")) parts.unshift("body");
    return parts.join(" > ");
  }
  const CSS_escape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));

  function merged() {
    const byEl = new Map();
    for (const c of state.applied) {
      if (!byEl.has(c.el)) byEl.set(c.el, { styles: {}, mobileStyles: {}, reasons: [], text: null });
      const m = byEl.get(c.el);
      for (const [p, v] of Object.entries(c.styles)) {
        // A shorthand set later replaces its longhands (padding wipes padding-top, etc.).
        for (const k of Object.keys(m.styles)) if (k.startsWith(p + "-")) delete m.styles[k];
        delete m.styles[p];
        m.styles[p] = v;
      }
      Object.assign(m.mobileStyles, c.mobileStyles || {});
      if (c.reason) m.reasons.push(c.reason);
      if (c.text != null) m.text = c.text;
    }
    return byEl;
  }

  function buildCSS() {
    const lines = [`/* Redline export for ${location.href}`, `   ${new Date().toISOString().slice(0, 10)}. Generated selectors are tied to the current markup; prefer moving these into your own classes. */`, ""];
    if (state.tokens?.palette) {
      lines.push(":root {");
      for (const [k, v] of Object.entries(state.tokens.palette)) {
        const name = String(k).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        if (SAFE_VALUE.test(String(v))) lines.push(`  --rl-${name}: ${v};`);
      }
      if (state.tokens.fontStack && SAFE_VALUE.test(state.tokens.fontStack)) lines.push(`  --rl-font: ${state.tokens.fontStack};`);
      lines.push("}", "");
    }
    for (const [el, m] of merged()) {
      if (!Object.keys(m.styles).length) continue;
      lines.push(`/* ${m.reasons.join(" ").replace(/\*\//g, "")} */`);
      lines.push(`${selectorFor(el)} {`);
      for (const [p, v] of Object.entries(m.styles)) lines.push(`  ${p}: ${v} !important;`);
      lines.push("}", "");
    }
    const responsive = [...merged()].filter(([, m]) => Object.keys(m.mobileStyles).length);
    if (responsive.length) {
      lines.push("@media (max-width: 640px) {");
      for (const [el, m] of responsive) {
        lines.push(`  ${selectorFor(el)} {`);
        for (const [p, v] of Object.entries(m.mobileStyles)) lines.push(`    ${p}: ${v} !important;`);
        lines.push("  }");
      }
      lines.push("}", "");
    }
    const copy = [...merged()].filter(([, m]) => m.text != null);
    if (copy.length) {
      lines.push("/* Copy changes (edit these in your HTML or CMS):");
      for (const [el, m] of copy) {
        const was = state.originals.get(el)?.get("__text") ?? "";
        lines.push(`   ${selectorFor(el)}: "${was.trim().slice(0, 80)}" -> "${m.text}"`);
      }
      lines.push("*/");
    }
    return lines.join("\n");
  }

  async function exportCSS() {
    const css = buildCSS();
    try {
      const url = URL.createObjectURL(new Blob([css], { type: "text/css" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `redline-${location.hostname || "page"}.css`;
      root.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      render({ flash: "Downloaded the CSS file." });
    } catch {
      const ok = await copyText(css);
      render({ flash: ok ? "Download was blocked here, so the CSS was copied to your clipboard." : "Couldn't download or copy the CSS on this page." });
    }
  }

  async function exportPNG() {
    const previousVisibility = host.style.visibility;
    const rootStyle = document.documentElement.style;
    const bodyStyle = document.body.style;
    const oldRootScroll = [rootStyle.getPropertyValue("scroll-behavior"), rootStyle.getPropertyPriority("scroll-behavior")];
    const oldBodyScroll = [bodyStyle.getPropertyValue("scroll-behavior"), bodyStyle.getPropertyPriority("scroll-behavior")];
    const oldX = window.scrollX;
    const oldY = window.scrollY;
    let objectUrl = "";
    const floatingStyles = [];
    host.style.visibility = "hidden";
    rootStyle.setProperty("scroll-behavior", "auto", "important");
    bodyStyle.setProperty("scroll-behavior", "auto", "important");
    try {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      if (!viewportWidth || !viewportHeight) throw new Error("The page viewport is unavailable for capture.");
      const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, viewportHeight);
      let fullHeight = pageHeight();
      let canvas = null;
      let context = null;
      let outputScale = 1;
      const maxSide = 32767;
      const maxPixels = 120_000_000;

      for (let top = 0; top < fullHeight; top += viewportHeight) {
        window.scrollTo(0, top);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 90))));
        fullHeight = Math.max(fullHeight, pageHeight());
        // Chrome limits captureVisibleTab to two calls per second.
        await new Promise((resolve) => setTimeout(resolve, 520));
        const result = await chrome.runtime.sendMessage({ type: "exportPng" });
        if (!result?.ok || !result.dataUrl) throw new Error(result?.error || "Couldn't capture the full page.");
        const image = await createImageBitmap(await (await fetch(result.dataUrl)).blob());

        if (!canvas) {
          const nativeScale = image.width / viewportWidth;
          outputScale = Math.min(
            nativeScale,
            maxSide / viewportWidth,
            maxSide / fullHeight,
            Math.sqrt(maxPixels / (viewportWidth * fullHeight)),
          );
          canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewportWidth * outputScale));
          canvas.height = Math.max(1, Math.ceil(fullHeight * outputScale));
          context = canvas.getContext("2d");
          if (!context) throw new Error("Couldn't create the image for export.");
        } else {
          const neededHeight = Math.ceil(fullHeight * outputScale);
          if (neededHeight > canvas.height) {
            if (neededHeight > maxSide || canvas.width * neededHeight > maxPixels) {
              image.close();
              throw new Error("This page is too tall to fit in one PNG. Try exporting a shorter section.");
            }
            const expanded = document.createElement("canvas");
            expanded.width = canvas.width;
            expanded.height = neededHeight;
            const expandedContext = expanded.getContext("2d");
            if (!expandedContext) {
              image.close();
              throw new Error("Couldn't extend the full-page image.");
            }
            expandedContext.drawImage(canvas, 0, 0);
            canvas = expanded;
            context = expandedContext;
          }
        }

        const actualTop = window.scrollY;
        const cropTopCss = Math.max(0, top - actualTop);
        const drawHeightCss = Math.max(0, Math.min(viewportHeight - cropTopCss, fullHeight - top));
        if (drawHeightCss > 0) {
          const sourceScale = image.height / viewportHeight;
          context.drawImage(
            image,
            0, Math.round(cropTopCss * sourceScale), image.width, Math.min(image.height, Math.ceil(drawHeightCss * sourceScale)),
            0, Math.round(top * outputScale), canvas.width, Math.ceil(drawHeightCss * outputScale),
          );
        }
        image.close();

        if (top === 0) {
          for (const element of document.querySelectorAll("body *")) {
            if (element === host || element === document.body) continue;
            const position = getComputedStyle(element).position;
            if (position !== "fixed" && position !== "sticky") continue;
            floatingStyles.push([element, element.style.getPropertyValue("visibility"), element.style.getPropertyPriority("visibility")]);
            element.style.setProperty("visibility", "hidden", "important");
          }
        }
      }

      const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn't encode the full-page PNG.")), "image/png"));
      objectUrl = URL.createObjectURL(png);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `redline-${location.hostname || "page"}-redesign.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      render({ flash: `Downloaded a full-page PNG (${canvas.width} × ${canvas.height}).` });
    } catch (error) {
      render({ flash: error.message || "Couldn't export a full-page PNG." });
    } finally {
      window.scrollTo(oldX, oldY);
      for (const [style, [value, priority]] of [[rootStyle, oldRootScroll], [bodyStyle, oldBodyScroll]]) {
        if (value) style.setProperty("scroll-behavior", value, priority);
        else style.removeProperty("scroll-behavior");
      }
      for (const [element, value, priority] of floatingStyles) {
        if (!element.isConnected) continue;
        if (value) element.style.setProperty("visibility", value, priority);
        else element.style.removeProperty("visibility");
      }
      host.style.visibility = previousVisibility;
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    }
  }

  async function copyPrompt() {
    const items = [...merged()].map(([el, m], i) => {
      const excerpt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
      const old = state.originals.get(el);
      const styles = Object.entries(m.styles).map(([p, v]) => {
        const before = old?.get(p)?.[0] || getComputedStyle(el).getPropertyValue(p);
        return `  - ${p}: ${before} → ${v}`;
      });
      const mobile = Object.entries(m.mobileStyles).map(([p, v]) => `  - ${p}: ${v}`);
      return [
        `### ${i + 1}. ${el.tagName.toLowerCase()} — ${excerpt || "(no text)"}`,
        `Target hint: ${selectorFor(el)} (verify against the actual source; this selector is only a page clue)`,
        m.reasons.length ? `Design reason: ${m.reasons.join(" ")}` : "",
        styles.length ? `Desktop changes:\n${styles.join("\n")}` : "",
        mobile.length ? `Mobile changes (max-width: 640px):\n${mobile.join("\n")}` : "",
        m.text != null ? `Copy change: ${JSON.stringify(m.text)}` : "",
      ].filter(Boolean).join("\n");
    });
    const prompt = `# Implement this Redline design review

Target page: ${location.href}
Page title: ${document.title}

## Goal
Implement the following visual and copy improvements in the source code that produces this page. The notes describe the intended result; they are not framework-specific code.

## Instructions for the coding assistant
- First inspect the project and identify its actual language, framework, component structure, routing, styling system, and icon dependencies. Do not assume React, Tailwind, plain HTML/CSS, or any other stack.
- Find the source components and styles that render each target. Treat the selectors below as clues only; do not paste them blindly into production CSS.
- Make the changes in the project's existing architecture and conventions. Reuse existing design tokens, components, and icon library when available. Preserve behavior, links, forms, accessibility, semantic structure, and responsive behavior.
- Keep the site's identity, audience, and content order. Avoid generic AI styling: no decorative gradients, emoji used as interface icons, excessive pills/cards, or arbitrary font swaps. Prefer the project's existing icon set; if it has none, use consistent Lucide SVG icons (https://lucide.dev) only where an icon improves meaning.
- Implement the requested changes rather than returning a mockup or CSS snippet. Do not invent facts or remove existing content.
- After implementation, inspect the affected desktop and mobile layouts, fix overflow/clipping, and run the project's relevant checks.

## Overall direction
${state.aiSummary || "Improve clarity and usability while preserving the page's existing visual identity."}
${state.tokens ? `\nSuggested design tokens (adapt to the project's system):\n${JSON.stringify(state.tokens, null, 2)}` : ""}
${state.reviewSummary ? `\nAI review result: ${state.reviewSummary}` : ""}

## Targeted changes
${items.length ? items.join("\n\n") : "No element-level changes were captured."}

## Acceptance checks
- Main page sections keep their intended alignment and content order.
- Text remains visible and readable at desktop and phone widths.
- Buttons, navigation, forms, and other interactions still work.
- Icons use one consistent library/style; avoid substituting emoji.
- No unnecessary visual effects or new product claims are introduced.`;
    const ok = await copyText(prompt);
    render({ flash: ok ? "Implementation brief copied. Paste it into any coding assistant with the page source project open." : "Couldn't copy the implementation brief on this page." });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;";
      root.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- lifecycle
  function resetAll() {
    state.runToken++;
    restoreAll();
    state.originals.clear();
    state.applied = [];
    state.pins.forEach((p) => p.pin.remove());
    state.pins = [];
    state.aiSummary = "";
    state.tokens = null;
    state.postScan = null;
    state.reviewSummary = "";
    state.reviewNeedsAttention = false;
    state.aiUsage = { input: 0, output: 0, calls: 0, available: true };
    closeMobilePreview();
    layer.classList.remove("pins-off");
    scan();
    audit();
    state.phase = "ready";
    render();
  }

  function exit(keepChanges = false) {
    state.runToken++;
    stopOrbit();
    closeMobilePreview();
    if (!keepChanges) restoreAll();
    host.remove();
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", syncOverlayScroll);
    if (!keepChanges) removeEventListener("resize", onResize);
    delete window.__redline;
  }

  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (root.querySelector(".device-backdrop")) closeMobilePreview();
    else exit();
  };
  let resizeT = 0;
  const onResize = () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { syncOverlayScroll(); clampDraggedPanel(); syncMobileStyles(); if (host.isConnected) layoutPins(); }, 150);
  };
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", syncOverlayScroll, { passive: true });
  addEventListener("resize", onResize);

  window.__redline = { toggle: exit };

  // ---------------------------------------------------------------- start
  scan();
  audit();
  render();
  chrome.runtime.sendMessage({ type: "settings" }).then((s) => {
    state.hasKey = !!s?.hasKey;
    state.provider = s?.provider || "anthropic";
    if (Array.isArray(s?.designSkills) && s.designSkills.length) state.designSkills = s.designSkills;
    state.activeDesignSkill = s?.activeDesignSkill || "balanced";
    if (state.phase === "ready") render();
  }).catch(() => {});
})();
