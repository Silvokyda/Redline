// Redline's independent page-rebuild experience. It snapshots the current DOM
// into a viewport image, then reveals it as a cursor crew scans down the page.
(() => {
  if (window.__redlineRebuild) {
    window.__redlineRebuild.toggle();
    return;
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startingScroll = scrollY;
  const colors = ["#f04458", "#3276f6", "#9b4dff", "#00a985", "#e99a16", "#ec6b34"];
  const agentNames = ["Type", "Layout", "Color", "Spacing", "Flow", "Detail", "Copy", "Grid", "Contrast", "Rhythm", "Mobile", "Access", "Content", "Shape", "Navigation", "Action", "Hierarchy", "Finish"];
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
  let listening = false;
  let cloneScrollY = 0;
  let crew = [];
  let targets = [];

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : ms));

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
      .page { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; border: 0;
        clip-path: inset(0 0 100% 0); pointer-events: none; }
      .agents { position: absolute; inset: 0 0 48px; pointer-events: none; overflow: hidden; }
      .agent { position: absolute; left: 0; top: 0; width: 17px; height: 22px; background: white;
        clip-path: polygon(0 0, 100% 76%, 60% 82%, 49% 100%); filter: drop-shadow(0 2px 3px #1118);
        transform: translate(-40px,-40px) rotate(-28deg); transition: transform 520ms cubic-bezier(.22,.72,.2,1); }
      .agent::before { content: ""; position: absolute; inset: 2px; background: var(--agent-color);
        clip-path: polygon(0 0, 100% 76%, 60% 82%, 49% 100%); }
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
    reveal = document.createElement("img");
    reveal.className = "page";
    reveal.alt = "The current page being rebuilt by Redline";
    const agents = document.createElement("div");
    agents.className = "agents";
    crew = agentNames.map((name, index) => {
      const cursor = document.createElement("span");
      cursor.className = "agent";
      cursor.dataset.name = name;
      cursor.style.setProperty("--agent-color", colors[index % colors.length]);
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
    scene.append(reveal, agents, toolbar);
    root.appendChild(scene);
    document.documentElement.appendChild(host);
    frame = reveal;
    crew.forEach((cursor, index) => {
      const x = innerWidth * (0.06 + ((index * 0.6180339) % 0.86));
      const y = innerHeight * (0.08 + ((index * 0.381966) % 0.76));
      setCursor(cursor, x, y);
    });
  }

  async function captureViewport() {
    if (!host?.isConnected) throw new Error("The Redline preview was closed.");
    const visibility = host.style.visibility;
    host.style.visibility = "hidden";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const response = await chrome.runtime.sendMessage({ type: "screenshot" });
      if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Could not capture this page.");
      return response.dataUrl;
    } finally {
      if (host?.isConnected) host.style.visibility = visibility;
    }
  }

  function setCursor(cursor, x, y) {
    const maxX = Math.max(14, innerWidth - 28);
    const maxY = Math.max(14, innerHeight - 74);
    cursor.style.transform = `translate(${Math.max(4, Math.min(maxX, x))}px, ${Math.max(4, Math.min(maxY, y))}px) rotate(-28deg)`;
  }

  function spreadTargets(targetsInView, startY) {
    const selected = [];
    const candidates = targetsInView
      .filter((target) => target.w < innerWidth * 0.95 && target.h < innerHeight * 0.8)
      .sort((a, b) => (a.w * a.h) - (b.w * b.h));
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 3; column++) {
        const point = candidates.find((target) => {
          if (selected.includes(target)) return false;
          const x = target.x - scrollX + target.w / 2;
          const y = target.y - startY + target.h / 2;
          return x >= innerWidth * column / 3 && x < innerWidth * (column + 1) / 3 &&
            y >= innerHeight * row / 2 && y < innerHeight * (row + 1) / 2;
        });
        if (point) selected.push(point);
      }
    }
    for (const point of candidates) {
      if (selected.length >= crew.length) break;
      if (!selected.includes(point)) selected.push(point);
    }
    const fallbackSpots = [[0.15, 0.22], [0.5, 0.22], [0.84, 0.22], [0.15, 0.72], [0.5, 0.72], [0.84, 0.72]];
    while (selected.length < Math.min(6, crew.length)) {
      const [x, y] = fallbackSpots[selected.length % fallbackSpots.length];
      selected.push({ x: scrollX + innerWidth * x, y: startY + innerHeight * y, w: innerWidth * 0.12, h: 40 });
    }
    return selected;
  }

  async function revealViewport(scrollPosition, index, count, token) {
    cloneScrollY = scrollPosition;
    playScanTone(index);
    if (autoScrollInput.checked) {
      window.scrollTo({ top: scrollPosition, behavior: reducedMotion ? "auto" : "smooth" });
      await pause(reducedMotion ? 0 : 520);
      cloneScrollY = scrollY;
    }
    const startY = cloneScrollY;
    const visible = targets.filter((target) => target.y >= startY - 40 && target.y < startY + innerHeight + 40);
    const image = await captureViewport();
    if (cancelled || token !== scanToken) return;
    frame.style.clipPath = "inset(0 0 100% 0)";
    frame.src = image;
    try { await frame.decode(); } catch {}
    const points = spreadTargets(visible, startY);
    for (let part = 1; part <= 12; part++) {
      if (cancelled || token !== scanToken) return;
      const amount = part / 12;
      frame.style.clipPath = `inset(0 0 ${100 - amount * 100}% 0)`;
      progress.style.width = `${Math.min(100, ((index + amount) / count) * 100)}%`;
      crew.forEach((cursor, cursorIndex) => {
        const targetIndex = points.length ? cursorIndex % points.length : -1;
        const target = targetIndex >= 0 ? points[targetIndex] : null;
        const lane = target ? Math.floor(cursorIndex / points.length) : cursorIndex;
        const phase = (part + cursorIndex) % 4;
        const x = target
          ? target.x - scrollX + target.w * (0.2 + (lane % 3) * 0.28) + (phase - 1.5) * 5
          : innerWidth * (0.08 + ((cursorIndex * 0.6180339 + part * 0.07) % 0.84));
        const y = target
          ? target.y - startY + target.h * (0.28 + (lane % 3) * 0.24) + (phase - 1.5) * 4
          : innerHeight * (0.12 + ((cursorIndex * 0.381966 + part * 0.045) % 0.72));
        setCursor(cursor, x, y);
      });
      await pause(58);
    }
  }

  async function build() {
    const token = ++scanToken;
    cancelled = false;
    if (!listening) { addEventListener("keydown", onKey, true); listening = true; }
    targets = findTargets();
    if (!host) buildOverlay();
    await pause(100);
    if (cancelled || token !== scanToken) return;
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
    host?.remove();
    host = null;
    frame = null;
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
