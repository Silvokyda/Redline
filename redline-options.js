const $ = (s) => document.querySelector(s);
const FIELDS = ["anthropicKey", "anthropicModel", "openaiKey", "openaiModel"];
const BUILTIN_SKILLS = globalThis.REDLINE_DESIGN_SKILLS || [];

function skillStatus(text, kind = "") {
  const el = $("#skillStatus");
  el.textContent = text;
  el.className = kind;
}

async function customSkills() {
  const { redlineCustomSkills = [] } = await chrome.storage.local.get("redlineCustomSkills");
  return Array.isArray(redlineCustomSkills) ? redlineCustomSkills : [];
}

function renderSkills(custom) {
  const list = $("#skillList");
  list.replaceChildren();
  for (const skill of [...BUILTIN_SKILLS, ...custom]) {
    const row = document.createElement("div");
    row.className = "skill-row";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = skill.name;
    const description = document.createElement("p");
    description.textContent = skill.description || skill.instructions;
    copy.append(name, description);
    row.append(copy);
    if (skill.id?.startsWith("custom-")) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${skill.name}`);
      remove.addEventListener("click", async () => {
        const kept = (await customSkills()).filter((item) => item.id !== skill.id);
        const { activeDesignSkill } = await chrome.storage.local.get("activeDesignSkill");
        const updates = { redlineCustomSkills: kept };
        if (activeDesignSkill === skill.id) updates.activeDesignSkill = "balanced";
        await chrome.storage.local.set(updates);
        renderSkills(kept);
        skillStatus(`Removed “${skill.name}”.`, "ok");
      });
      row.append(remove);
    }
    list.append(row);
  }
}

function normalizeImportedSkills(value) {
  const source = Array.isArray(value) ? value : [value];
  if (!source.length || source.length > 20) throw new Error("Install between 1 and 20 skills at a time.");
  return source.map((item, index) => {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const instructions = typeof item?.instructions === "string" ? item.instructions.trim() : "";
    const description = typeof item?.description === "string" ? item.description.trim() : "";
    if (!name || name.length > 60) throw new Error(`Skill ${index + 1} needs a name of 1–60 characters.`);
    if (!instructions || instructions.length > 12000) throw new Error(`“${name}” needs instructions of 1–12,000 characters.`);
    return {
      id: `custom-${crypto.randomUUID()}`,
      name,
      description: description.slice(0, 180),
      instructions,
    };
  });
}

function markdownSkill(fileName, markdown) {
  let body = markdown.trim();
  const metadata = {};
  const frontmatter = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const field = line.match(/^(name|description):\s*(.*)$/i);
      if (field) metadata[field[1].toLowerCase()] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    body = body.slice(frontmatter[0].length).trim();
  }
  const baseName = fileName.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ").trim();
  const name = metadata.name || (baseName.toLowerCase() === "skill" ? "Imported Claude skill" : baseName);
  return normalizeImportedSkills({ name, description: metadata.description || "Imported Markdown design skill", instructions: body });
}

function showProvider(p) {
  document.querySelectorAll(".field").forEach((f) => (f.hidden = f.dataset.for !== p));
}

function status(text, kind = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = kind;
}

async function load() {
  const s = await chrome.storage.local.get(["provider", ...FIELDS]);
  const provider = s.provider || "anthropic";
  document.querySelector(`input[name=provider][value=${provider}]`).checked = true;
  FIELDS.forEach((k) => ($("#" + k).value = s[k] || ""));
  showProvider(provider);
  renderSkills(await customSkills());
}

async function save() {
  const data = { provider: document.querySelector("input[name=provider]:checked").value };
  FIELDS.forEach((k) => (data[k] = $("#" + k).value.trim()));
  await chrome.storage.local.set(data);
}

document.querySelectorAll("input[name=provider]").forEach((r) =>
  r.addEventListener("change", () => showProvider(r.value))
);

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await save();
  status("Saved.", "ok");
});

$("#test").addEventListener("click", async () => {
  await save();
  status("Testing…");
  const res = await chrome.runtime.sendMessage({ type: "testKey" });
  if (res?.ok) status(`Connected. Using ${res.model}.`, "ok");
  else status(res?.error || "Couldn't connect.", "err");
});

$("#clear").addEventListener("click", async () => {
  await chrome.storage.local.remove(["anthropicKey", "openaiKey"]);
  $("#anthropicKey").value = "";
  $("#openaiKey").value = "";
  status("Keys removed.", "ok");
});

$("#skillFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = /\.json$/i.test(file.name)
      ? normalizeImportedSkills(JSON.parse(text))
      : markdownSkill(file.name, text);
    const existing = await customSkills();
    const names = new Set(existing.map((skill) => skill.name.toLocaleLowerCase()));
    const unique = imported.filter((skill) => {
      const key = skill.name.toLocaleLowerCase();
      if (names.has(key)) return false;
      names.add(key);
      return true;
    });
    if (!unique.length) throw new Error("Those skill names are already installed.");
    const all = [...existing, ...unique];
    await chrome.storage.local.set({ redlineCustomSkills: all });
    renderSkills(all);
    skillStatus(`Installed ${unique.length} design skill${unique.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    skillStatus(err.message || "Couldn't install that skill file.", "err");
  } finally {
    e.target.value = "";
  }
});

load();
