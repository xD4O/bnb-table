// Shared narrator settings: choose Local Ollama (customizable endpoint) or an
// OpenAI-compatible API (base URL + key). Persisted in localStorage and reused by the
// launcher and the solo screen. The API key is stored locally in the browser and only
// sent to this local server, which forwards it to the provider.

const KEY = "bnb.narrator";

// One-click base URLs for common OpenAI-compatible providers.
export const PRESETS = [
  { name: "Custom / other", url: "" },
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "Groq", url: "https://api.groq.com/openai/v1" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "Together AI", url: "https://api.together.xyz/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { name: "Mistral", url: "https://api.mistral.ai/v1" },
  { name: "Local Ollama (OpenAI-compat)", url: "http://localhost:11434/v1" },
];

const DEFAULTS = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
};

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) { localStorage.setItem(KEY, JSON.stringify(s)); }

export async function fetchModels(s) {
  try {
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    if (!res.ok) return { models: [] };
    return await res.json();
  } catch { return { models: [] }; }
}

// Render the settings form into `container` and keep localStorage in sync.
export function renderSettings(container) {
  const s = loadSettings();
  container.innerHTML = `
    <div class="settings">
      <div class="seg" role="tablist">
        <button type="button" class="seg-btn" data-prov="ollama">🖥️ Local Ollama</button>
        <button type="button" class="seg-btn" data-prov="api">☁️ API</button>
      </div>
      <div class="set-panel" data-panel="ollama">
        <label>Ollama endpoint<input id="set-ollamaUrl" value="${esc(s.ollamaUrl)}" placeholder="http://localhost:11434" /></label>
      </div>
      <div class="set-panel" data-panel="api" hidden>
        <label>Provider preset<select id="set-preset">${PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("")}</select></label>
        <label>API base URL <span class="hint">(OpenAI-compatible)</span><input id="set-apiBaseUrl" value="${esc(s.apiBaseUrl)}" placeholder="https://api.openai.com/v1" /></label>
        <label>API key<input id="set-apiKey" type="password" value="${esc(s.apiKey)}" placeholder="sk-… (stored only in this browser)" /></label>
      </div>
      <div class="model-row">
        <button type="button" class="gm-btn" id="set-load">↻ Load models</button>
        <select id="set-model" title="Narrator model"></select>
        <span id="set-status" class="set-status"></span>
      </div>
    </div>`;

  const $ = (id) => container.querySelector("#" + id);
  const cur = () => loadSettings();
  const put = (patch) => saveSettings({ ...cur(), ...patch });

  function applyProvider(prov) {
    put({ provider: prov });
    container.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.prov === prov));
    container.querySelectorAll(".set-panel").forEach((p) => (p.hidden = p.dataset.panel !== prov));
  }
  container.querySelectorAll(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => { applyProvider(b.dataset.prov); loadModels(); })
  );
  applyProvider(s.provider);

  const bind = (id, field) => { const el = $(id); if (el) el.addEventListener("input", () => put({ [field]: el.value.trim() })); };
  bind("set-ollamaUrl", "ollamaUrl");
  bind("set-apiKey", "apiKey");

  // preset <-> base URL sync
  const preset = $("set-preset");
  const matchPreset = (url) => { const i = PRESETS.findIndex((p) => p.url && p.url === url); return i >= 0 ? i : 0; };
  preset.value = String(matchPreset(s.apiBaseUrl));
  preset.addEventListener("change", () => {
    const p = PRESETS[Number(preset.value)];
    if (p && p.url) { $("set-apiBaseUrl").value = p.url; put({ apiBaseUrl: p.url }); loadModels(); }
    else $("set-apiBaseUrl").focus();
  });
  $("set-apiBaseUrl").addEventListener("input", () => {
    const v = $("set-apiBaseUrl").value.trim();
    put({ apiBaseUrl: v });
    preset.value = String(matchPreset(v)); // reflect manual edits back to the preset select
  });
  $("set-model").addEventListener("change", () => put({ model: $("set-model").value }));
  $("set-load").addEventListener("click", loadModels);

  async function loadModels() {
    const status = $("set-status");
    status.textContent = "loading…"; status.className = "set-status";
    const settings = cur();
    const { models } = await fetchModels(settings);
    const sel = $("set-model");
    if (!models || !models.length) {
      sel.innerHTML = `<option value="">(no models found — narration will use fallbacks)</option>`;
      status.textContent = "⚠ none found"; status.className = "set-status warn-txt";
      return;
    }
    sel.innerHTML = models.map((m) => `<option value="${esc(m)}" ${m === settings.model ? "selected" : ""}>${esc(m)}</option>`).join("");
    if (!settings.model || !models.includes(settings.model)) { sel.value = models[0]; put({ model: models[0] }); }
    status.textContent = `✓ ${models.length} model${models.length === 1 ? "" : "s"}`; status.className = "set-status ok-txt";
  }

  loadModels(); // auto-populate on open
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
