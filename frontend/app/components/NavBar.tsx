"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";

const API = "http://localhost:8001";

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [gemini, setGemini] = useState("");
  const [groq, setGroq] = useState("");
  const [cerebras, setCerebras] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setGemini(localStorage.getItem("wis_gemini_key") || "");
    setGroq(localStorage.getItem("wis_groq_key") || "");
    setCerebras(localStorage.getItem("wis_cerebras_key") || "");
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API}/settings/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gemini_key: gemini, groq_key: groq, cerebras_key: cerebras }),
      });
      if (!res.ok) throw new Error(await res.text());
      if (gemini) localStorage.setItem("wis_gemini_key", gemini);
      else localStorage.removeItem("wis_gemini_key");
      if (groq) localStorage.setItem("wis_groq_key", groq);
      else localStorage.removeItem("wis_groq_key");
      if (cerebras) localStorage.setItem("wis_cerebras_key", cerebras);
      else localStorage.removeItem("wis_cerebras_key");
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 1200);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const KeyInput = ({
    label, value, onChange, placeholder, href
  }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; href: string }) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-[#1c1410]">{label}</label>
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="text-[10px] text-[#c07820] hover:underline">Get free key →</a>
      </div>
      <input
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-xs rounded-lg border border-[#e8e0d5] bg-white focus:outline-none focus:border-[#c07820] font-mono placeholder:text-[#b8a898] placeholder:font-sans"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#f7f3ed] rounded-2xl shadow-2xl border border-[#e8e0d5] w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-[#e8e0d5]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-bold text-[15px] text-[#1c1410]">AI Settings</h2>
              <p className="text-xs text-[#6b5c4e] mt-0.5">Add your API keys to use WhatIfSabha. All free tiers work.</p>
            </div>
            <button onClick={onClose} className="w-7 h-7 rounded-full bg-[#e8e0d5] hover:bg-[#d8c8b8] flex items-center justify-center text-[#6b5c4e] text-sm transition-colors">✕</button>
          </div>
        </div>

        {/* Keys */}
        <div className="px-6 py-5 space-y-4">
          <KeyInput
            label="Gemini API Key"
            value={gemini}
            onChange={setGemini}
            placeholder="AIza..."
            href="https://aistudio.google.com/apikey"
          />
          <KeyInput
            label="Groq API Key"
            value={groq}
            onChange={setGroq}
            placeholder="gsk_..."
            href="https://console.groq.com/keys"
          />
          <KeyInput
            label="Cerebras API Key"
            value={cerebras}
            onChange={setCerebras}
            placeholder="csk-..."
            href="https://cloud.cerebras.ai"
          />

          <div className="pt-1 rounded-xl bg-[#fef9f0] border border-[#f0c060]/40 px-4 py-3">
            <p className="text-[11px] text-[#6b5c4e] leading-relaxed">
              <span className="font-semibold text-[#c07820]">How keys are used:</span>{" "}
              Gemini for story analysis · Cerebras for character agents · Groq for judge &amp; narrator.
              Keys are stored in your browser and sent to the local backend only.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-[#c07820] hover:bg-[#a86a18] text-white text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {saved ? "✓ Saved!" : saving ? "Saving..." : "Save Keys"}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-[#e8e0d5] text-[#6b5c4e] hover:bg-white text-sm transition-colors">
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
    const gemini = localStorage.getItem("wis_gemini_key");
    const groq = localStorage.getItem("wis_groq_key");
    const cerebras = localStorage.getItem("wis_cerebras_key");

    const pushAndCheck = async () => {
      if (gemini || groq || cerebras) {
        await fetch(`${API}/settings/keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gemini_key: gemini, groq_key: groq, cerebras_key: cerebras }),
        }).catch(() => {});
      }
      const status = await fetch(`${API}/settings/keys/status`).then(r => r.json()).catch(() => null);
      if (status) setKeysConfigured(status.gemini && status.groq && status.cerebras);
    };
    pushAndCheck();
  }, []);

  const Logo = () => (
    <Link href="/" className="flex items-center gap-2.5 group shrink-0">
      <div className="w-8 h-8 rounded-xl bg-[#c07820] flex items-center justify-center shadow-sm group-hover:bg-[#a86a18] transition-colors overflow-hidden">
        <span style={{ color: "#fef9c3", fontSize: "28px", lineHeight: 1 }}>☸</span>
      </div>
      <span className="font-bold text-[17px] tracking-tight text-[#1c1410]">
        WhatIf<span className="text-[#c07820]">Sabha</span>
      </span>
    </Link>
  );

  const navLink = (href: string, label: string, active?: boolean) => (
    <Link
      key={href}
      href={href}
      className={`text-xs font-medium transition-colors px-3.5 py-1.5 rounded-full border ${
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
                {navLink(`/story/${storyId}/graph`, "Graph", pathname.includes("/graph"))}
                {navLink(`/story/${storyId}/debate`, "Sabha ⚡", pathname.includes("/debate"))}
                <div className="w-px h-4 bg-[#e8e0d5] mx-1" />
              </>
            )}
            {!isHome && navLink("/", "+ New Story")}
            <button
              onClick={() => setShowSettings(true)}
              title="AI Settings"
              className="ml-1 relative w-8 h-8 rounded-full border border-[#e8e0d5] bg-white/60 hover:bg-white hover:border-[#c8b89a] flex items-center justify-center text-[#6b5c4e] hover:text-[#1c1410] transition-colors text-sm"
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
