// Redline's independent page-rebuild experience. It snapshots the current DOM
// into an isolated preview, then reveals it as a cursor crew scans down the page.
(() => {
  if (window.__redlineRebuild) {
    window.__redlineRebuild.toggle();
    return;
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startingScroll = scrollY;
  const colors = ["#f04458", "#3276f6", "#9b4dff", "#00a985", "#e99a16", "#ec6b34"];
  let host = null;
  let frame = null;
  let reveal = null;
  let status = null;
  let progress = null;
  let autoScrollInput = null;
  let editorButton = null;
  let soundButton = null;
  let audioContext = null;
  let soundEnabled = false;
  let autoScrollPreference = true;
  let cancelled = false;
  let pageScanComplete = false;
  let scanToken = 0;
  let resizeTimer = 0;
  let listening = false;
  let cloneScrollY = 0;
  let crew = [];
  let targets = [];
  let renderPieces = [];

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : ms));

  function makeSnapshot() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script, noscript, redline-overlay, redline-rebuild-overlay").forEach((node) => node.remove());
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove());
    clone.querySelectorAll("*").forEach((node) => {
      for (const attr of [...node.attributes]) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if (node instanceof HTMLInputElement) {
        if (node.type === "password") node.value = "";
        else node.setAttribute("value", node.value);
      }
      if (node instanceof HTMLTextAreaElement) node.textContent = node.value;
      if (node instanceof HTMLSelectElement) {
        [...node.options].forEach((option) => option.toggleAttribute("selected", option.selected));
      }
    });
    const head = clone.querySelector("head");
    if (head) {
      const base = document.createElement("base");
      base.href = location.href;
      head.prepend(base);
    }
    return `<!doctype html>${clone.outerHTML}`;
  }

  function findTargets() {
    const selector = "header, nav, main, section, article, h1, h2, h3, p, button, a, img, footer, [role=main]";
    const found = [...document.querySelectorAll(selector)].map((el) => {
      const rect = el.getBoundingClientRect();
      return { el, x: rect.left + scrollX, y: rect.top + scrollY, w: rect.width, h: rect.height };
    }).filter((item) => item.w > 12 && item.h > 8 && getComputedStyle(item.el).visibility !== "hidden");
    const unique = [];
    for (const item of found) {
      const covered = unique.some((prior) => prior.el.contains(item.el) &&
        Math.abs(prior.x - item.x) < 8 && Math.abs(prior.y - item.y) < 8 &&
        Math.abs(prior.w - item.w) < 16 && Math.abs(prior.h - item.h) < 16);
      if (!covered) unique.push(item);
    }
    return unique.sort((a, b) => a.y - b.y).slice(0, 260);
  }

  function installStyles(root) {
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .scene { position: fixed; inset: 0; z-index: 2147483646; overflow: hidden; background: #f7f8fa; color: #20242b;
        font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .page { position: absolute; inset: 0 0 48px; width: 100%; height: calc(100% - 48px); border: 0; background: #fff;
        clip-path: inset(0 0 100% 0); pointer-events: none; }
      .veil { position: absolute; inset: 0 0 48px; background: #f7f8fa; pointer-events: none; }
      .agents { position: absolute; inset: 0 0 48px; pointer-events: none; overflow: hidden; }
      .agent { position: absolute; left: 0; top: 0; width: 14px; height: 19px; border: 2px solid white; border-radius: 2px 8px 8px 8px;
        background: var(--agent-color); box-shadow: 0 2px 7px #1115; transform: translate(-40px,-40px) rotate(-28deg);
        transition: transform 520ms cubic-bezier(.22,.72,.2,1); }
      .agent::after { content: ""; position: absolute; left: 11px; top: 14px; width: max-content; padding: 2px 6px; border-radius: 8px;
        background: var(--agent-color); color: white; font: 600 10px/1.2 system-ui,sans-serif; box-shadow: 0 1px 4px #1113; }
      .agent[data-name]::after { content: attr(data-name); }
      .toolbar { position: absolute; z-index: 2; left: 50%; bottom: 10px; transform: translateX(-50%); display: flex; align-items: center;
        gap: 8px; max-width: calc(100vw - 20px); padding: 7px 9px; border: 1px solid #30343a; border-radius: 13px;
        background: #202328; color: #f4f5f7; box-shadow: 0 5px 20px #0003; white-space: nowrap; }
      .brand { font-weight: 700; padding: 0 3px; }
      .status { max-width: 32vw; overflow: hidden; text-overflow: ellipsis; color: #c8cbd1; }
      .track { width: clamp(52px, 12vw, 140px); height: 5px; overflow: hidden; border-radius: 5px; background: #444951; }
      .track i { display: block; width: 0; height: 100%; border-radius: inherit; background: #f04458; transition: width .15s linear; }
      button, label { font: 600 12px/1 system-ui,sans-serif; }
      button { border: 0; border-radius: 8px; padding: 8px 10px; background: #353940; color: white; cursor: pointer; }
      button:hover { background: #4b5059; }
      button.primary { background: #f04458; }
      button.primary:hover { background: #d92e47; }
      .auto { display:flex; align-items:center; gap:5px; color:#d8dbe0; }
      .auto input { accent-color:#f04458; }
      @media (max-width: 620px) {
        .toolbar { left: 8px; right: 8px; transform: none; width: auto; justify-content: center; gap: 5px; padding: 6px; }
        .status { max-width: 25vw; }
        .track { width: 42px; }
        button { padding: 8px 7px; }
      }
    `;
    root.appendChild(style);
  }

  function buildOverlay() {
    host = document.createElement("redline-rebuild-overlay");
    host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;";
    const root = host.attachShadow({ mode: "closed" });
    installStyles(root);
    const scene = document.createElement("div");
    scene.className = "scene";
    reveal = document.createElement("iframe");
    reveal.className = "page";
    reveal.title = "Redline page rebuild preview";
    reveal.setAttribute("sandbox", "allow-same-origin");
    reveal.srcdoc = makeSnapshot();
    const veil = document.createElement("div");
    veil.className = "veil";
    const agents = document.createElement("div");
    agents.className = "agents";
    crew = colors.map((color, index) => {
      const cursor = document.createElement("span");
      cursor.className = "agent";
      cursor.dataset.name = ["Type", "Layout", "Color", "Spacing", "Flow", "Detail"][index];
      cursor.style.setProperty("--agent-color", color);
      agents.appendChild(cursor);
      return cursor;
    });
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Redline page scan");
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "Redline";
    status = document.createElement("span");
    status.className = "status";
    status.textContent = "Scanning the page…";
    const track = document.createElement("span");
    track.className = "track";
    progress = document.createElement("i");
    track.appendChild(progress);
    const autoLabel = document.createElement("label");
    autoLabel.className = "auto";
    autoScrollInput = document.createElement("input");
    autoScrollInput.type = "checkbox";
    autoScrollInput.checked = autoScrollPreference;
    autoScrollInput.addEventListener("change", () => {
      autoScrollPreference = autoScrollInput.checked;
      if (autoScrollInput.checked && !pageScanComplete) window.__redlineRebuild?.restart();
    });
    autoLabel.append(autoScrollInput, document.createTextNode("Auto-scroll"));
    soundButton = document.createElement("button");
    soundButton.textContent = soundEnabled ? "Sound on" : "Sound off";
    soundButton.title = "Enable soft scan sounds";
    soundButton.addEventListener("click", toggleSound);
    editorButton = document.createElement("button");
    editorButton.className = "primary";
    editorButton.textContent = "Redesign";
    editorButton.hidden = true;
    editorButton.addEventListener("click", openEditor);
    const closeButton = document.createElement("button");
    closeButton.textContent = "Exit";
    closeButton.addEventListener("click", () => close(false));
    toolbar.append(brand, status, track, autoLabel, soundButton, editorButton, closeButton);
    scene.append(reveal, veil, agents, toolbar);
    root.appendChild(scene);
    document.documentElement.appendChild(host);
    frame = reveal;
    reveal.addEventListener("load", () => {
      try {
        const doc = reveal.contentDocument;
        doc.addEventListener("click", (event) => event.preventDefault(), true);
        doc.addEventListener("submit", (event) => event.preventDefault(), true);
      } catch {}
    });
  }

  function syncFrameScroll() {
    if (!frame?.contentWindow) return;
    frame.contentWindow.scrollTo(0, cloneScrollY);
  }

  function prepareRenderPieces() {
    renderPieces = [];
    const doc = frame?.contentDocument;
    if (!doc) return;
    const selector = "h1,h2,h3,h4,p,li,button,a,img,picture,figure,blockquote,input,textarea,select,[role=button],[role=heading]";
    for (const element of doc.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || getComputedStyle(element).visibility === "hidden") continue;
      const style = getComputedStyle(element);
      const piece = {
        element,
        opacity: style.opacity,
        transform: style.transform === "none" ? "none" : style.transform,
        revealed: false,
      };
      element.style.setProperty("transition", "opacity .25s ease, transform .32s cubic-bezier(.2,.75,.2,1)", "important");
      element.style.setProperty("opacity", "0", "important");
      element.style.setProperty("transform", "translateY(8px)", "important");
      renderPieces.push(piece);
    }
  }

  function showPiece(piece) {
    if (piece.revealed) return;
    piece.revealed = true;
    piece.element.style.setProperty("opacity", piece.opacity, "important");
    piece.element.style.setProperty("transform", piece.transform, "important");
  }

  const onScroll = () => {
    if (!autoScrollInput?.checked) cloneScrollY = scrollY;
    syncFrameScroll();
  };
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncFrameScroll, 100);
  };

  function setCursor(cursor, x, y) {
    const maxX = Math.max(14, innerWidth - 28);
    const maxY = Math.max(14, innerHeight - 74);
    cursor.style.transform = `translate(${Math.max(4, Math.min(maxX, x))}px, ${Math.max(4, Math.min(maxY, y))}px) rotate(-28deg)`;
  }

  async function revealViewport(scrollPosition, index, count, token) {
    cloneScrollY = scrollPosition;
    playScanTone(index);
    if (autoScrollInput.checked) {
      window.scrollTo({ top: scrollPosition, behavior: reducedMotion ? "auto" : "smooth" });
      await pause(reducedMotion ? 0 : 320);
    }
    syncFrameScroll();
    const startY = cloneScrollY;
    const visible = targets.filter((target) => target.y >= startY - 40 && target.y < startY + innerHeight + 40);
    const target = visible[Math.min(visible.length - 1, Math.floor(visible.length * 0.62))] || null;
    for (let part = 1; part <= 12; part++) {
      if (cancelled || token !== scanToken) return;
      const amount = part / 12;
      frame.style.clipPath = `inset(0 0 ${100 - amount * 100}% 0)`;
      progress.style.width = `${Math.min(100, ((index + amount) / count) * 100)}%`;
      let pieceTarget = null;
      for (const piece of renderPieces) {
        if (piece.revealed) continue;
        const rect = piece.element.getBoundingClientRect();
        if (rect.top >= 0 && rect.top <= innerHeight * amount) {
          showPiece(piece);
          pieceTarget ||= rect;
        }
      }
      const x = pieceTarget ? pieceTarget.left + Math.min(pieceTarget.width * 0.5, 100)
        : target ? target.x - scrollX + target.w * ((part % 5) / 6) : innerWidth * (0.2 + (part % 5) * 0.13);
      const y = pieceTarget ? pieceTarget.top + Math.min(pieceTarget.height * 0.5, 20)
        : target ? target.y - startY + target.h * 0.5 : innerHeight * (0.24 + (part % 4) * 0.16);
      crew.forEach((cursor, cursorIndex) => {
        const phase = (part + cursorIndex) % 6;
        setCursor(cursor, x + (phase - 2) * (9 + cursorIndex), y + ((cursorIndex % 3) - 1) * 17);
      });
      await pause(58);
    }
  }

  async function build() {
    const token = ++scanToken;
    cancelled = false;
    if (!listening) {
      addEventListener("scroll", onScroll, { passive: true });
      addEventListener("resize", onResize, { passive: true });
      addEventListener("keydown", onKey, true);
      listening = true;
    }
    targets = findTargets();
    if (!host) buildOverlay();
    await new Promise((resolve) => {
      if (frame.contentDocument?.readyState === "complete") resolve();
      else frame.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 1800);
    });
    await pause(260);
    if (cancelled || token !== scanToken) return;
    prepareRenderPieces();
    const fullPageScan = autoScrollInput.checked;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const stepSize = Math.max(440, Math.round(innerHeight * 0.76));
    const stops = [];
    for (let y = 0; y < maxScroll; y += stepSize) stops.push(y);
    if (!stops.length || stops[stops.length - 1] < maxScroll) stops.push(maxScroll);
    if (!fullPageScan) stops.splice(0, stops.length, startingScroll);
    status.textContent = `${targets.length} page areas found`;
    for (let i = 0; i < stops.length; i++) {
      if (cancelled || token !== scanToken) return;
      status.textContent = fullPageScan ? `Scanning page ${i + 1} of ${stops.length}` : "Scanning the visible screen";
      await revealViewport(stops[i], i, stops.length, token);
      if (fullPageScan && !autoScrollInput.checked && i < stops.length - 1) {
        status.textContent = `Auto-scroll off · paused at screen ${i + 1} of ${stops.length}`;
        editorButton.hidden = false;
        return;
      }
    }
    if (cancelled || token !== scanToken) return;
    frame.style.clipPath = "inset(0 0 0 0)";
    progress.style.width = "100%";
    pageScanComplete = fullPageScan && autoScrollInput.checked;
    status.textContent = pageScanComplete
      ? `Full page scan complete · ${targets.length} areas`
      : `Visible screen ready · ${targets.length} areas`;
    editorButton.hidden = false;
  }

  function openEditor() {
    close(false, false);
    window.scrollTo({ top: startingScroll, behavior: "auto" });
    chrome.runtime.sendMessage({ type: "redline:start" }).catch(() => {});
  }

  async function toggleSound() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      status.textContent = "This browser does not support scan sounds";
      return;
    }
    try {
      if (!audioContext) audioContext = new AudioContextClass();
      await audioContext.resume();
      soundEnabled = !soundEnabled;
      soundButton.textContent = soundEnabled ? "Sound on" : "Sound off";
      soundButton.setAttribute("aria-pressed", String(soundEnabled));
      if (soundEnabled) playScanTone(0);
    } catch {
      status.textContent = "Sound could not start; check this tab's audio settings";
    }
  }

  function playScanTone(index) {
    if (!soundEnabled || !audioContext || audioContext.state !== "running") return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const now = audioContext.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime([440, 523.25, 587.33, 659.25, 783.99][index % 5], now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.035, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.19);
    } catch {}
  }

  const onKey = (event) => {
    if (event.key === "Escape") close(false);
  };

  function close(keepPosition, removeController = true) {
    cancelled = true;
    scanToken++;
    clearTimeout(resizeTimer);
    host?.remove();
    host = null;
    frame = null;
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onResize);
    removeEventListener("keydown", onKey, true);
    listening = false;
    if (removeController) delete window.__redlineRebuild;
    if (!keepPosition) window.scrollTo({ top: startingScroll, behavior: "auto" });
    if (removeController && audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
      soundEnabled = false;
    }
  }

  window.__redlineRebuild = {
    toggle: () => close(false),
    restart: () => {
      close(false, false);
      setTimeout(() => build().catch((error) => {
        console.warn("Redline page scan failed:", error);
        close(false);
      }), 50);
    },
  };

  build().catch((error) => {
    console.warn("Redline page scan failed:", error);
    close(false);
  });
})();
