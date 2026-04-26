"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { API } from "../config";
import BrandMark from "./BrandMark";

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [anthropic, setAnthropic] = useState("");
  const [openai, setOpenai] = useState("");
  const [gemini, setGemini] = useState("");
  const [groq, setGroq] = useState("");
  const [cerebras, setCerebras] = useState("");
  const [nvidia, setNvidia] = useState("");
  // Bring-your-own-provider — any OpenAI-compatible endpoint, anywhere
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [envStatus, setEnvStatus] = useState<{
    anthropic:boolean;openai:boolean;gemini:boolean;groq:boolean;cerebras:boolean;nvidia:boolean;
    custom?:boolean; custom_base_url?:string|null; custom_model?:string|null;
    models?: Record<string, Record<string, string>>;
  } | null>(null);

  // Per-provider live model lists (fetched on demand from /settings/providers/{p}/models)
  const PROVIDERS = ["anthropic","openai","gemini","groq","cerebras","nvidia"] as const;
  type ProviderName = typeof PROVIDERS[number];
  type ModelCfg = { main?: string; agent?: string; analysis?: string; judge?: string; narrator?: string };

  const [models,        setModels]        = useState<Record<string, string[]>>({});
  const [recommended,   setRecommended]   = useState<Record<string, string | null>>({});
  const [modelCfg,      setModelCfg]      = useState<Record<string, ModelCfg>>({});
  const [modelLoading,  setModelLoading]  = useState<Record<string, boolean>>({});
  const [modelError,    setModelError]    = useState<Record<string, string>>({});
  const [advancedOpen,  setAdvancedOpen]  = useState<Record<string, boolean>>({});

  useEffect(() => {
    setAnthropic(localStorage.getItem("wis_anthropic_key") || "");
    setOpenai(localStorage.getItem("wis_openai_key") || "");
    setGemini(localStorage.getItem("wis_gemini_key") || "");
    setGroq(localStorage.getItem("wis_groq_key") || "");
    setCerebras(localStorage.getItem("wis_cerebras_key") || "");
    setNvidia(localStorage.getItem("wis_nvidia_key") || "");
    setCustomBaseUrl(localStorage.getItem("wis_custom_base_url") || "");
    setCustomApiKey(localStorage.getItem("wis_custom_api_key") || "");
    setCustomModel(localStorage.getItem("wis_custom_model") || "");
    // Restore saved per-provider model picks
    const initialCfg: Record<string, ModelCfg> = {};
    for (const p of PROVIDERS) {
      const stored = localStorage.getItem(`wis_${p}_models`);
      if (stored) { try { initialCfg[p] = JSON.parse(stored); } catch {} }
    }
    setModelCfg(initialCfg);
    fetch(`${API}/settings/keys/status`).then(r => r.json()).then(setEnvStatus).catch(() => {});
  }, []);

  async function fetchModelsFor(provider: string) {
    setModelLoading(s => ({...s, [provider]: true}));
    setModelError(s => { const x = {...s}; delete x[provider]; return x; });
    try {
      const r = await fetch(`${API}/settings/providers/${provider}/models`);
      if (!r.ok) {
        const detail = await r.json().catch(() => ({detail: r.statusText}));
        setModelError(s => ({...s, [provider]: String(detail.detail || `HTTP ${r.status}`)}));
        return;
      }
      const data = await r.json();
      const raw: string[] = Array.isArray(data.models) ? data.models : [];
      // Defensive dedupe — some providers (NVIDIA NIM) return the same model id twice
      const list = Array.from(new Set(raw));
      const rec: string | null = (data.recommended as string) || null;
      setModels(s => ({...s, [provider]: list}));
      setRecommended(s => ({...s, [provider]: rec}));
      // Auto-pick the recommended model if no user pick yet, otherwise first model
      setModelCfg(s => {
        if (s[provider]?.main) return s;
        if (list.length === 0) return s;
        const pick = (rec && list.includes(rec)) ? rec : list[0];
        return {...s, [provider]: {...(s[provider] || {}), main: pick}};
      });
    } catch (e: any) {
      setModelError(s => ({...s, [provider]: String(e?.message || e)}));
    } finally {
      setModelLoading(s => ({...s, [provider]: false}));
    }
  }

  // After we know which providers have keys, auto-fetch their model lists
  useEffect(() => {
    if (!envStatus) return;
    for (const p of PROVIDERS) {
      if ((envStatus as any)[p] && !models[p] && !modelLoading[p]) {
        fetchModelsFor(p);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envStatus]);

  // Auto-expand the custom panel if a custom provider is already configured
  useEffect(() => {
    if (envStatus?.custom) setShowCustom(true);
  }, [envStatus]);

  async function testCustomProvider() {
    setTesting(true);
    setTestResult(null);
    try {
      const url = customBaseUrl.replace(/\/$/, "") + "/models";
      const r = await fetch(url, { headers: { Authorization: `Bearer ${customApiKey}` } });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        const count = Array.isArray(data?.data) ? data.data.length : null;
        setTestResult({ ok: true, msg: count != null ? `Connected · ${count} models available` : "Connected" });
      } else {
        setTestResult({ ok: false, msg: `HTTP ${r.status} from ${url}` });
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: `Cannot reach: ${e?.message || e}` });
    } finally {
      setTesting(false);
    }
  }

  // Auto-expand "More providers" if any of those keys are already set
  useEffect(() => {
    if (envStatus && (envStatus.gemini || envStatus.groq || envStatus.cerebras || envStatus.nvidia)) {
      setShowMore(true);
    }
  }, [envStatus]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const cleanCfg = (cfg: ModelCfg | undefined) => {
        if (!cfg) return undefined;
        const out: ModelCfg = {};
        for (const k of ["main","agent","analysis","judge","narrator"] as const) {
          if (cfg[k]) out[k] = cfg[k];
        }
        return Object.keys(out).length ? out : undefined;
      };

      const res = await fetch(`${API}/settings/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anthropic_key: anthropic, openai_key: openai,
          gemini_key: gemini, groq_key: groq, cerebras_key: cerebras, nvidia_key: nvidia,
          custom_llm_base_url: customBaseUrl,
          custom_llm_api_key:  customApiKey,
          custom_llm_model:    customModel,
          anthropic_models: cleanCfg(modelCfg.anthropic),
          openai_models:    cleanCfg(modelCfg.openai),
          gemini_models:    cleanCfg(modelCfg.gemini),
          groq_models:      cleanCfg(modelCfg.groq),
          cerebras_models:  cleanCfg(modelCfg.cerebras),
          nvidia_models:    cleanCfg(modelCfg.nvidia),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Persist to localStorage
      const pairs: [string, string][] = [
        ["wis_anthropic_key",    anthropic],
        ["wis_openai_key",       openai],
        ["wis_gemini_key",       gemini],
        ["wis_groq_key",         groq],
        ["wis_cerebras_key",     cerebras],
        ["wis_nvidia_key",       nvidia],
        ["wis_custom_base_url",  customBaseUrl],
        ["wis_custom_api_key",   customApiKey],
        ["wis_custom_model",     customModel],
      ];
      for (const [key, val] of pairs) {
        if (val) localStorage.setItem(key, val); else localStorage.removeItem(key);
      }
      // Persist per-provider model picks
      for (const p of PROVIDERS) {
        const cfg = cleanCfg(modelCfg[p]);
        if (cfg) localStorage.setItem(`wis_${p}_models`, JSON.stringify(cfg));
        else     localStorage.removeItem(`wis_${p}_models`);
      }
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 1200);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Clear a single provider's key — sends an explicit empty string to the
  // backend (overrides any value in .env) and wipes localStorage.
  async function clearProviderKey(provider: ProviderName | "custom") {
    if (!confirm(`Clear the ${provider} key? This removes it from the running app and overrides any value still in your backend .env file.`)) return;
    setError("");
    try {
      const payload: Record<string, string> = {};
      if (provider === "anthropic") { setAnthropic(""); payload.anthropic_key = ""; localStorage.removeItem("wis_anthropic_key"); }
      else if (provider === "openai") { setOpenai(""); payload.openai_key = ""; localStorage.removeItem("wis_openai_key"); }
      else if (provider === "gemini") { setGemini(""); payload.gemini_key = ""; localStorage.removeItem("wis_gemini_key"); }
      else if (provider === "groq") { setGroq(""); payload.groq_key = ""; localStorage.removeItem("wis_groq_key"); }
      else if (provider === "cerebras") { setCerebras(""); payload.cerebras_key = ""; localStorage.removeItem("wis_cerebras_key"); }
      else if (provider === "nvidia") { setNvidia(""); payload.nvidia_key = ""; localStorage.removeItem("wis_nvidia_key"); }
      else if (provider === "custom") {
        setCustomBaseUrl(""); setCustomApiKey(""); setCustomModel("");
        payload.custom_llm_base_url = ""; payload.custom_llm_api_key = ""; payload.custom_llm_model = "";
        localStorage.removeItem("wis_custom_base_url");
        localStorage.removeItem("wis_custom_api_key");
        localStorage.removeItem("wis_custom_model");
      }
      const res = await fetch(`${API}/settings/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      // Refresh the configured-status badges
      try {
        const statusRes = await fetch(`${API}/settings/keys/status`);
        if (statusRes.ok) setEnvStatus(await statusRes.json());
      } catch {}
    } catch (e) {
      setError(String(e));
    }
  }

  const KeyInput = ({
    label, value, onChange, placeholder, href, configured, linkText, onClear
  }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; href: string; configured?: boolean; linkText?: string; onClear?: () => void | Promise<void> }) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-[#1c1410]">{label}</label>
          {configured !== undefined && (
            configured
              ? <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">✓ set</span>
              : <span className="text-xs text-[#b8a898] bg-[#f7f3ed] border border-[#e8e0d5] px-2 py-0.5 rounded-full font-medium">not set</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {configured && onClear && (
            <button
              type="button"
              onClick={() => onClear()}
              className="text-xs text-red-600 hover:text-red-700 hover:underline font-medium"
              title="Remove this key from the running app and override any value in .env"
            >
              Clear key
            </button>
          )}
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="text-xs text-[#c07820] hover:underline">{linkText || "Get key →"}</a>
        </div>
      </div>
      <input
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={configured && !value ? "already set — paste new key to override" : placeholder}
        className={`w-full px-3 py-2.5 text-sm rounded-lg border bg-white focus:outline-none focus:border-[#c07820] font-mono placeholder:font-sans transition-colors ${
          configured && !value ? "border-emerald-200 placeholder:text-emerald-400/70" : "border-[#e8e0d5] placeholder:text-[#b8a898]"
        }`}
      />
    </div>
  );

  // Per-provider model picker — main dropdown + collapsible Advanced (per role)
  const ModelPicker = ({ provider }: { provider: ProviderName }) => {
    const list   = models[provider] || [];
    const rec    = recommended[provider] || null;
    const cfg    = modelCfg[provider] || {};
    const open   = !!advancedOpen[provider];
    const loading = !!modelLoading[provider];
    const error   = modelError[provider];
    const isConfigured = !!(envStatus as any)?.[provider];

    if (!isConfigured) return null;

    const setRole = (role: keyof ModelCfg, v: string) =>
      setModelCfg(s => ({ ...s, [provider]: { ...(s[provider] || {}), [role]: v || undefined } }));

    const labelFor = (m: string) => rec && m === rec ? `${m}  (recommended)` : m;

    const RoleSelect = ({ label, role }: { label: string; role: keyof ModelCfg }) => (
      <label className="flex items-center gap-2 text-xs">
        <span className="w-32 text-[#6b5c4e]">{label}</span>
        <select
          value={cfg[role] ?? cfg.main ?? ""}
          onChange={e => setRole(role, e.target.value)}
          className="flex-1 text-xs px-2 py-1.5 rounded-md border border-[#e8e0d5] bg-white focus:outline-none focus:border-[#c07820]"
        >
          {list.map(m => <option key={m} value={m}>{labelFor(m)}</option>)}
        </select>
      </label>
    );

    return (
      <div className="mt-2 space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={cfg.main || ""}
            onChange={e => setRole("main", e.target.value)}
            disabled={loading || list.length === 0}
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-[#e8e0d5] bg-white focus:outline-none focus:border-[#c07820]"
          >
            {loading && <option value="">Fetching models…</option>}
            {!loading && list.length === 0 && <option value="">No models yet — click ↻</option>}
            {!loading && list.length > 0 && !cfg.main && <option value="">— Select a model —</option>}
            {list.map(m => <option key={m} value={m}>{labelFor(m)}</option>)}
          </select>
          <button
            type="button"
            onClick={() => fetchModelsFor(provider)}
            disabled={loading}
            title="Refresh model list"
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-[#e8e0d5] text-[#6b5c4e] hover:bg-white hover:border-[#c8b89a] disabled:opacity-50"
          >
            {loading ? "…" : "↻"}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}

        {list.length > 0 && (
          <button
            type="button"
            onClick={() => setAdvancedOpen(s => ({ ...s, [provider]: !open }))}
            className="text-[11px] text-[#a09282] hover:text-[#6b5c4e] flex items-center gap-1.5"
          >
            <span className="text-[9px]">{open ? "▾" : "▸"}</span>
            Advanced — different models per task
          </button>
        )}

        {open && list.length > 0 && (
          <div className="pl-3 border-l-2 border-[#e8e0d5] space-y-1.5 pt-1">
            <RoleSelect label="Character voice"   role="agent" />
            <RoleSelect label="Story chat"        role="analysis" />
            <RoleSelect label="Debate moderator"  role="judge" />
            <RoleSelect label="Narrator / summary" role="narrator" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#f7f3ed] rounded-2xl shadow-2xl border border-[#e8e0d5] w-full max-w-md mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-[#e8e0d5] shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-bold text-lg text-[#1c1410]">AI Settings</h2>
              <p className="text-sm text-[#6b5c4e] mt-0.5">Any <span className="font-semibold">one</span> key is enough to run everything.</p>
            </div>
            <button onClick={onClose} className="w-9 h-9 rounded-full bg-[#e8e0d5] hover:bg-[#d8c8b8] flex items-center justify-center text-[#6b5c4e] text-base transition-colors">✕</button>
          </div>
        </div>

        {/* Scrollable keys area */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          {/* Quick Start — most common providers */}
          <div className="space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#c07820]">Quick Start</p>
            <div className="space-y-1.5">
              <KeyInput label="Anthropic (Claude)" value={anthropic} onChange={setAnthropic}
                placeholder="sk-ant-..." href="https://console.anthropic.com/settings/keys"
                configured={envStatus?.anthropic}
                onClear={() => clearProviderKey("anthropic")} />
              <ModelPicker provider="anthropic" />
            </div>
            <div className="space-y-1.5">
              <KeyInput label="OpenAI" value={openai} onChange={setOpenai}
                placeholder="sk-..." href="https://platform.openai.com/api-keys"
                configured={envStatus?.openai}
                onClear={() => clearProviderKey("openai")} />
              <ModelPicker provider="openai" />
            </div>
            <div className="space-y-1.5">
              <KeyInput label="Google Gemini" value={gemini} onChange={setGemini}
                placeholder="AIza..." href="https://aistudio.google.com/apikey"
                configured={envStatus?.gemini} linkText="Get free key →"
                onClear={() => clearProviderKey("gemini")} />
              <ModelPicker provider="gemini" />
            </div>
          </div>

          {/* More providers — collapsible */}
          <div>
            <button
              onClick={() => setShowMore(!showMore)}
              className="text-xs text-[#6b5c4e] hover:text-[#1c1410] flex items-center gap-1.5 transition-colors"
            >
              <span className="text-[10px]">{showMore ? "▾" : "▸"}</span>
              <span className="font-medium">More providers (free tiers)</span>
              {envStatus && (envStatus.groq || envStatus.cerebras || envStatus.nvidia) && (
                <span className="text-xs text-emerald-600">● active</span>
              )}
            </button>
            {showMore && (
              <div className="mt-3 space-y-4">
                <div className="space-y-1.5">
                  <KeyInput label="Groq" value={groq} onChange={setGroq}
                    placeholder="gsk_..." href="https://console.groq.com/keys"
                    configured={envStatus?.groq} linkText="Get free key →"
                    onClear={() => clearProviderKey("groq")} />
                  <ModelPicker provider="groq" />
                </div>
                <div className="space-y-1.5">
                  <KeyInput label="Cerebras" value={cerebras} onChange={setCerebras}
                    placeholder="csk-..." href="https://cloud.cerebras.ai"
                    configured={envStatus?.cerebras} linkText="Get free key →"
                    onClear={() => clearProviderKey("cerebras")} />
                  <ModelPicker provider="cerebras" />
                </div>
                <div className="space-y-1.5">
                  <KeyInput label="NVIDIA NIM" value={nvidia} onChange={setNvidia}
                    placeholder="nvapi-..." href="https://build.nvidia.com"
                    configured={envStatus?.nvidia} linkText="Get free key →"
                    onClear={() => clearProviderKey("nvidia")} />
                  <ModelPicker provider="nvidia" />
                </div>
              </div>
            )}
          </div>

          {/* Bring your own provider — any OpenAI-compatible endpoint */}
          <div>
            <button
              onClick={() => setShowCustom(!showCustom)}
              className="text-xs text-[#6b5c4e] hover:text-[#1c1410] flex items-center gap-1.5 transition-colors"
            >
              <span className="text-[10px]">{showCustom ? "▾" : "▸"}</span>
              <span className="font-medium">Bring your own provider</span>
              {envStatus?.custom && <span className="text-xs text-emerald-600">● active</span>}
              <span className="text-[10px] text-[#a09282] italic ml-1">(any OpenAI-compatible API)</span>
            </button>
            {showCustom && (
              <div className="mt-3 space-y-3 rounded-xl border border-[#e8e0d5] bg-white p-4">
                <p className="text-xs text-[#6b5c4e] leading-relaxed">
                  Works with any provider that exposes OpenAI dialect: DeepSeek, Qwen, Kimi, Zhipu,
                  OpenRouter, Together, Fireworks, Perplexity, Ollama / LM Studio (local), Azure OpenAI, …
                </p>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-[#1c1410]">Base URL</label>
                  <input
                    type="text"
                    value={customBaseUrl}
                    onChange={e => setCustomBaseUrl(e.target.value)}
                    placeholder="https://api.deepseek.com/v1"
                    className="w-full px-3 py-2.5 text-sm rounded-lg border border-[#e8e0d5] bg-white focus:outline-none focus:border-[#c07820] font-mono placeholder:font-sans placeholder:text-[#b8a898] transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-[#1c1410]">API key</label>
                  <input
                    type="password"
                    value={customApiKey}
                    onChange={e => setCustomApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full px-3 py-2.5 text-sm rounded-lg border border-[#e8e0d5] bg-white focus:outline-none focus:border-[#c07820] font-mono placeholder:font-sans placeholder:text-[#b8a898] transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-[#1c1410]">Model id</label>
                  <input
                    type="text"
                    value={customModel}
                    onChange={e => setCustomModel(e.target.value)}
                    placeholder="deepseek-chat"
                    className="w-full px-3 py-2.5 text-sm rounded-lg border border-[#e8e0d5] bg-white focus:outline-none focus:border-[#c07820] font-mono placeholder:font-sans placeholder:text-[#b8a898] transition-colors"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={testCustomProvider}
                    disabled={!customBaseUrl || !customApiKey || testing}
                    className="text-xs px-3 py-1.5 rounded-full border border-[#e8e0d5] text-[#6b5c4e] hover:bg-[#f7f3ed] hover:border-[#c8b89a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {testing ? "Testing…" : "Test connection"}
                  </button>
                  {testResult && (
                    <span className={`text-xs ${testResult.ok ? "text-emerald-700" : "text-red-600"}`}>
                      {testResult.ok ? "✓" : "✕"} {testResult.msg}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl bg-[#fef9f0] border border-[#f0c060]/40 px-4 py-3">
            <p className="text-xs text-[#6b5c4e] leading-relaxed">
              <span className="font-semibold text-[#c07820]">Single-key mode:</span>{" "}
              Any one key runs the full app — upload, analysis, debates, everything.
              Multiple keys enable optimal model routing per role.
              Keys stored in your browser only.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-2 flex items-center gap-3 shrink-0 border-t border-[#e8e0d5]">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 py-3 rounded-xl bg-[#c07820] hover:bg-[#a86a18] text-white text-base font-semibold transition-colors disabled:opacity-60"
          >
            {saved ? "✓ Saved!" : saving ? "Saving..." : "Save Keys"}
          </button>
          <button onClick={onClose} className="px-5 py-3 rounded-xl border border-[#e8e0d5] text-[#6b5c4e] hover:bg-white text-base transition-colors">
            Cancel
          </button>
        </div>
        {error && <p className="px-6 pb-4 text-xs text-red-500">{error}</p>}
      </div>
    </div>
  );
}

export default function NavBar() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const storyMatch = pathname.match(/^\/story\/([^/]+)/);
  const storyId = storyMatch ? storyMatch[1] : null;
  const [showSettings, setShowSettings] = useState(false);
  const [keysConfigured, setKeysConfigured] = useState<boolean | null>(null);

  // Push stored keys to backend on mount, then check status
  useEffect(() => {
    const anthropic = localStorage.getItem("wis_anthropic_key");
    const openai = localStorage.getItem("wis_openai_key");
    const gemini = localStorage.getItem("wis_gemini_key");
    const groq = localStorage.getItem("wis_groq_key");
    const cerebras = localStorage.getItem("wis_cerebras_key");
    const nvidia = localStorage.getItem("wis_nvidia_key");
    const customBase  = localStorage.getItem("wis_custom_base_url");
    const customKey   = localStorage.getItem("wis_custom_api_key");
    const customModel = localStorage.getItem("wis_custom_model");

    const pushAndCheck = async () => {
      const haveAny = anthropic || openai || gemini || groq || cerebras || nvidia
        || (customBase && customKey && customModel);
      if (haveAny) {
        await fetch(`${API}/settings/keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            anthropic_key: anthropic, openai_key: openai,
            gemini_key: gemini, groq_key: groq, cerebras_key: cerebras, nvidia_key: nvidia,
            custom_llm_base_url: customBase,
            custom_llm_api_key:  customKey,
            custom_llm_model:    customModel,
          }),
        }).catch(() => {});
      }
      const status = await fetch(`${API}/settings/keys/status`).then(r => r.json()).catch(() => null);
      if (status) {
        // Any single configured provider is enough
        setKeysConfigured(
          status.anthropic || status.openai || status.gemini || status.groq || status.cerebras || status.nvidia || status.custom
        );
      }
    };
    pushAndCheck();
  }, []);

  const Logo = () => (
    <Link href="/" className="flex items-center gap-2.5 group shrink-0">
      <BrandMark size={32} className="shrink-0" />
      <span className="font-bold text-lg tracking-tight text-[#1c1410]">
        WhatIf<span className="text-[#c07820]">Sabha</span>
      </span>
    </Link>
  );

  const navLink = (href: string, label: string, active?: boolean) => (
    <Link
      key={href}
      href={href}
      className={`text-sm font-medium transition-colors px-4 py-2 rounded-full border ${
        active
          ? "bg-[#c07820] text-white border-[#c07820]"
          : "text-[#6b5c4e] hover:text-[#1c1410] border-[#e8e0d5] hover:border-[#c8b89a] bg-white/60 hover:bg-white"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#f7f3ed]/95 backdrop-blur-md border-b border-[#e8e0d5]">
        <div className="px-8 lg:px-12 h-14 flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-1.5">
            {storyId && (
              <>
                {navLink(`/story/${storyId}`, "Story", pathname === `/story/${storyId}`)}
                {navLink(`/story/${storyId}/characters`, "Characters", pathname.includes("/characters"))}
                {navLink(`/story/${storyId}/debate`, "Debate ⚡", pathname.includes("/debate"))}
                <div className="w-px h-4 bg-[#e8e0d5] mx-1" />
              </>
            )}
            {!isHome && navLink("/", "Home")}
            <button
              onClick={() => setShowSettings(true)}
              title="AI Settings"
              className="ml-1 relative w-9 h-9 rounded-full border border-[#e8e0d5] bg-white/60 hover:bg-white hover:border-[#c8b89a] flex items-center justify-center text-[#6b5c4e] hover:text-[#1c1410] transition-colors text-base"
            >
              ⚙
              {keysConfigured !== null && (
                <span className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-white ${keysConfigured ? "bg-green-400" : "bg-red-400"}`} />
              )}
            </button>
          </div>
        </div>
      </header>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
