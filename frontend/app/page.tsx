"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8001";

const ROLE_CHIP: Record<string, string> = {
  protagonist: "bg-amber-50 border-amber-200 text-amber-900",
  antagonist:  "bg-red-50 border-red-200 text-red-900",
  supporting:  "bg-blue-50 border-blue-200 text-blue-900",
  neutral:     "bg-stone-100 border-stone-200 text-stone-600",
};

const CHAR_COLORS = ["#c07820","#dc2626","#3b82f6","#16a34a","#7c3aed","#0891b2","#be185d","#d97706"];

const SAMPLE_DEBATE = [
  { char: "Boxer",    col: "#c07820", line: "Napoleon — tell me plainly — did you send me to the knacker's?" },
  { char: "Napoleon", col: "#dc2626", line: "Slander spread by enemies of the farm. You were sent to the finest surgeon in the county." },
  { char: "Benjamin", col: "#78716c", line: "I saw the van. 'Horse Slaughterer and Glue Boiler.' The lettering was quite clear." },
];

type Story = {
  id: string;
  title: string;
  author?: string;
  themes?: string[];
  word_count?: number;
  created_at?: string;
  character_count?: number;
  debate_count?: number;
};

export default function Home() {
  const router  = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging,    setDragging]    = useState(false);
  const [error,       setError]       = useState("");
  const [storyId,     setStoryId]     = useState<string | null>(null);
  const [status,      setStatus]      = useState("idle");
  const [storyData,   setStoryData]   = useState<any>(null);
  const [characters,  setCharacters]  = useState<any[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Library
  const [library,          setLibrary]          = useState<Story[]>([]);
  const [libraryLoading,   setLibraryLoading]   = useState(true);
  const [confirmDeleteId,  setConfirmDeleteId]  = useState<string | null>(null);
  const [deletingId,       setDeletingId]       = useState<string | null>(null);

  const handleDeleteStory = async (storyId: string) => {
    setDeletingId(storyId);
    try {
      await fetch(`${API}/stories/${storyId}`, { method: "DELETE" });
      setLibrary(prev => prev.filter(s => s.id !== storyId));
    } catch {}
    setDeletingId(null);
    setConfirmDeleteId(null);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activityLog]);

  // Fetch library on mount
  useEffect(() => {
    fetch(`${API}/stories`)
      .then(r => r.json())
      .then(async (data: Story[]) => {
        if (!Array.isArray(data)) { setLibraryLoading(false); return; }
        const enriched = await Promise.all(data.map(async s => {
          try {
            const [cr, dr] = await Promise.all([
              fetch(`${API}/stories/${s.id}/characters`),
              fetch(`${API}/stories/${s.id}/debates`),
            ]);
            const chars   = await cr.json();
            const debates = await dr.json();
            return {
              ...s,
              character_count: Array.isArray(chars)  ? chars.length   : 0,
              debate_count:    Array.isArray(debates) ? debates.length : 0,
            };
          } catch { return s; }
        }));
        setLibrary(enriched);
        setLibraryLoading(false);
      })
      .catch(() => setLibraryLoading(false));
  }, []);

  const isProcessing = status !== "idle" && status !== "ready" && status !== "error";
  const isDone       = status === "ready";
  const hasStarted   = isProcessing || isDone;

  // Polling
  const pollStoppedRef = useRef(false);
  useEffect(() => {
    if (!storyId) return;
    pollStoppedRef.current = false;
    const poll = async () => {
      if (pollStoppedRef.current) return;
      try {
        const res  = await fetch(`${API}/stories/${storyId}/status`);
        const data = await res.json();
        if (pollStoppedRef.current) return;
        setStatus(data.status);
        if (Array.isArray(data.progress_log) && data.progress_log.length > 0) {
          setActivityLog(data.progress_log.map((e: { msg: string }) => e.msg));
        }
        if (data.status === "ready") {
          pollStoppedRef.current = true;
          const [sr, cr] = await Promise.all([
            fetch(`${API}/stories/${storyId}`),
            fetch(`${API}/stories/${storyId}/characters`),
          ]);
          setStoryData(await sr.json());
          const ch = await cr.json();
          setCharacters(Array.isArray(ch) ? ch : []);
        } else if (data.status !== "error") {
          setTimeout(poll, 2500);
        }
      } catch { if (!pollStoppedRef.current) setTimeout(poll, 3000); }
    };
    poll();
    return () => { pollStoppedRef.current = true; };
  }, [storyId]);

  const handleUpload = async (file: File) => {
    if (!file.name.endsWith(".pdf")) { setError("Only PDF files are supported."); return; }
    setError("");
    setStatus("uploading");
    setActivityLog(["Uploading PDF..."]);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || "Upload failed."); }
      const data = await res.json();
      setStoryId(data.story_id);
    } catch (e: any) { setError(e.message); setStatus("idle"); }
  };

  return (
    <main className="flex-1 flex flex-col">
      <section className="grid md:grid-cols-2" style={{ minHeight: "calc(100vh - 56px)" }}>

        {/* ── LEFT: Upload hero + library ── */}
        <div className="relative flex flex-col justify-start px-12 lg:px-16 pt-14 pb-12 border-r border-[#e8e0d5] overflow-y-auto overflow-x-hidden">
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-br from-amber-50/40 via-transparent to-transparent" />
          <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-amber-100/15 blur-3xl pointer-events-none" />

          <div className="relative z-10 flex flex-col gap-8 w-full">
            {/* Headline */}
            <div className="space-y-5">
              <h1 className="text-[72px] lg:text-[80px] font-black tracking-[-3px] leading-[0.92] text-[#1c1410]">
                What if<br />
                things had<br />
                gone{" "}
                <span className="ink-shimmer">differently?</span>
              </h1>
              <p className="text-[17px] text-[#6b5c4e] leading-relaxed">
                Upload any story as a PDF. The engine analyses its characters, maps every relationship, then lets them debate your alternate scenario live.
              </p>
            </div>

            {/* Upload zone */}
            <div className="space-y-3">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleUpload(f); }}
                onClick={() => !hasStarted && fileRef.current?.click()}
                className={`rounded-2xl border-2 transition-all duration-200 bg-white overflow-hidden
                  ${hasStarted        ? "border-[#e8e0d5] cursor-default" :
                    dragging          ? "border-[#c07820] bg-amber-50/60 scale-[1.01] cursor-copy shadow-lg shadow-amber-100/50" :
                                        "border-dashed border-[#e8e0d5] hover:border-[#c07820]/50 hover:shadow-md cursor-pointer"}`}
              >
                <input ref={fileRef} type="file" accept=".pdf" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />

                {isProcessing ? (
                  <div className="p-8">
                    <div className="flex items-center gap-4 mb-4">
                      <div className="text-4xl animate-breathe shrink-0">📜</div>
                      <div>
                        <p className="font-semibold text-[#1c1410]">Analyzing your story...</p>
                        <p className="text-sm text-[#a09282] mt-0.5">Watch characters appear on the right →</p>
                      </div>
                    </div>
                    <div className="h-1 bg-[#f0ebe4] rounded-full overflow-hidden">
                      <div className="h-full bg-[#c07820] rounded-full animate-breathe" style={{ width: `${Math.min(10 + activityLog.length * 5, 90)}%`, transition: "width 0.5s ease" }} />
                    </div>
                  </div>
                ) : isDone ? (
                  <div className="p-8 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-lg shrink-0">✓</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-[#1c1410] truncate">{storyData?.title || "Story ready"}</p>
                        {storyData?.author && <p className="text-sm text-[#a09282]">by {storyData.author}</p>}
                      </div>
                    </div>
                    {characters.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {characters.slice(0, 8).map((c: any) => (
                          <span key={c.name} className={`text-xs px-2.5 py-1 rounded-full border font-medium ${ROLE_CHIP[c.role] || ROLE_CHIP.neutral}`}>
                            {c.name}
                          </span>
                        ))}
                        {characters.length > 8 && <span className="text-xs text-[#a09282] py-1">+{characters.length - 8} more</span>}
                      </div>
                    )}
                    <button
                      onClick={() => router.push(`/story/${storyId}`)}
                      className="w-full bg-[#c07820] hover:bg-[#a86a18] text-white font-bold py-3 rounded-xl text-sm transition-colors shadow-sm"
                    >
                      Enter the story ⚡
                    </button>
                  </div>
                ) : (
                  <div className="p-8 flex flex-col items-center text-center gap-5">
                    <div className={`w-16 h-16 rounded-2xl border-2 flex items-center justify-center text-3xl transition-all duration-200 ${dragging ? "bg-amber-100 border-[#c07820] scale-110" : "bg-[#faf7f2] border-dashed border-[#d4c4a8]"}`}>
                      {dragging ? "↓" : "📄"}
                    </div>
                    <div>
                      <p className="font-semibold text-[#1c1410] text-base">
                        {dragging ? "Release to upload" : "Drop your story PDF here"}
                      </p>
                      <p className="text-[#a09282] text-sm mt-1">or <span className="text-[#c07820] underline underline-offset-2">click to browse</span> your files</p>
                    </div>
                    <div className="w-full border-t border-[#f0ebe4] pt-4 grid grid-cols-3 gap-3 text-center">
                      {[["⚡", "~60s"], ["🎭", "Characters"], ["✍️", "New ending"]].map(([icon, label]) => (
                        <div key={label} className="space-y-1">
                          <div className="text-lg">{icon}</div>
                          <p className="text-xs text-[#a09282]">{label}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {!hasStarted && (
                <p className="text-center text-xs text-[#c8b89a]">
                  Try with: Animal Farm · Mahabharata · Hamlet · Any story
                </p>
              )}

              {/* Terminal feed */}
              {(isProcessing || (isDone && activityLog.length > 0)) && (
                <div className="bg-[#0f0d0a] rounded-xl overflow-hidden border border-[#2a2018]">
                  <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#2a2018]">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
                    <span className="ml-2 text-xs text-white/50 font-mono">analysis.log</span>
                    {isDone && <span className="ml-auto text-xs text-emerald-400/60 font-mono">done</span>}
                  </div>
                  <div className="px-3 py-3 space-y-1.5">
                    {activityLog.length === 0 ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[#c07820] font-mono text-xs animate-breathe">▶</span>
                        <span className="text-white/40 font-mono text-xs">Starting pipeline...</span>
                      </div>
                    ) : activityLog.map((msg, i) => {
                      const isLast = i === activityLog.length - 1 && isProcessing;
                      return (
                        <div key={i} className="flex items-start gap-2 font-mono text-xs">
                          <span className={`shrink-0 mt-px ${isLast ? "text-[#c07820] animate-breathe" : "text-emerald-400/70"}`}>
                            {isLast ? "▶" : "✓"}
                          </span>
                          <span className={isLast ? "text-white/90" : "text-white/45"}>{msg}</span>
                        </div>
                      );
                    })}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}

              {error && (
                <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-xl p-4 flex gap-2">
                  <span className="shrink-0 mt-0.5">✕</span>{error}
                </div>
              )}
            </div>

            {/* ── Previously uploaded stories ── */}
            {!hasStarted && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-[#e8e0d5]" />
                  <span className="text-xs font-semibold tracking-[0.15em] text-[#a09282] uppercase">or continue a story</span>
                  <div className="flex-1 h-px bg-[#e8e0d5]" />
                </div>

                {libraryLoading ? (
                  <div className="space-y-2">
                    {[1, 2].map(i => (
                      <div key={i} className="h-14 rounded-xl bg-[#f0ebe4] animate-pulse" />
                    ))}
                  </div>
                ) : library.length === 0 ? (
                  <p className="text-center text-xs text-[#c8b89a] py-2">No previous stories yet</p>
                ) : (
                  <div className="space-y-2">
                    {library.map((s, i) => {
                      const accent = CHAR_COLORS[i % CHAR_COLORS.length];
                      const isConfirming = confirmDeleteId === s.id;
                      return (
                        <div key={s.id} className="group relative flex items-center gap-3 bg-white border border-[#e8e0d5] hover:border-[#c8b89a] rounded-xl px-4 py-3 transition-all duration-150 hover:shadow-sm">
                          <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-white text-xs font-bold"
                            style={{ backgroundColor: accent }}>
                            {(s.title || "?")[0].toUpperCase()}
                          </div>
                          {isConfirming ? (
                            <div className="flex-1 flex items-center justify-between gap-2">
                              <p className="text-sm text-[#1c1410]">Remove this story?</p>
                              <div className="flex gap-2 shrink-0">
                                <button
                                  onClick={() => handleDeleteStory(s.id)}
                                  disabled={deletingId === s.id}
                                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium transition-colors disabled:opacity-60"
                                >
                                  {deletingId === s.id ? "Removing…" : "Remove"}
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="text-xs px-3 py-1.5 rounded-lg border border-[#e8e0d5] text-[#6b5c4e] hover:bg-[#f7f3ed] transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <Link href={`/story/${s.id}`} className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-[#1c1410] truncate group-hover:text-[#c07820] transition-colors">
                                  {s.title || "Untitled"}
                                </p>
                                <p className="text-xs text-[#a09282] truncate">
                                  {s.author ? `by ${s.author}` : ""}
                                  {s.author && (s.character_count || s.debate_count) ? " · " : ""}
                                  {s.character_count ? `${s.character_count} characters` : ""}
                                  {s.character_count && s.debate_count ? " · " : ""}
                                  {s.debate_count ? `${s.debate_count} debate${s.debate_count !== 1 ? "s" : ""}` : ""}
                                  {s.created_at && (
                                    <> · {new Date(s.created_at + (s.created_at?.endsWith("Z") ? "" : "Z")).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</>
                                  )}
                                </p>
                              </Link>
                              <button
                                onClick={() => setConfirmDeleteId(s.id)}
                                className="opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7 rounded-lg bg-[#f7f3ed] hover:bg-red-50 hover:text-red-500 text-[#a09282] flex items-center justify-center text-sm border border-transparent hover:border-red-200 shrink-0"
                                title="Remove story"
                              >
                                ✕
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: How it works ── */}
        <div className="overflow-hidden flex flex-col" id="how-it-works">
          <div className="flex-1 bg-white px-10 lg:px-14 py-14 space-y-12 overflow-y-auto">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-[#a09282] uppercase mb-2">How it works</p>
              <h2 className="text-2xl font-bold text-[#1c1410]">From PDF to alternate history</h2>
            </div>
            <div className="space-y-8">
              {[
                { icon: "📖", n: "01", title: "Upload any story PDF", body: "Drop in Animal Farm, the Mahabharata, Hamlet — any fiction. The engine reads it, identifies every character, maps the arc of events, and researches them against real-world sources." },
                { icon: "🔬", n: "02", title: "Characters come alive", body: "Each character gets a Fair Witness profile — cross-referenced with Wikipedia and web sources, then analysed from 3 independent AI perspectives. You see who they really are." },
                { icon: "⚡", n: "03", title: "Pose your 'What if?'", body: "Once ready, describe your divergence point. What if Boxer refused the slaughterhouse? What if Karna joined the Pandavas? The characters take it from there." },
                { icon: "🎭", n: "04", title: "Watch the Sabha unfold", body: "Characters debate in real-time, drawing on their own motivations and relationships. They ask each other questions, push back, reveal hidden feelings." },
                { icon: "✍️", n: "05", title: "A new ending is written", body: "After the debate concludes, an alternate ending is generated — grounded in the characters' own choices, not a generic rewrite." },
              ].map(s => (
                <div key={s.n} className="flex gap-4">
                  <div className="w-10 h-10 rounded-xl bg-[#fef3e2] border border-[#f0c060]/40 flex items-center justify-center text-lg shrink-0 mt-0.5">
                    {s.icon}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono font-bold text-[#c07820]">{s.n}</span>
                      <span className="font-semibold text-[#1c1410] text-sm">{s.title}</span>
                    </div>
                    <p className="text-[#6b5c4e] text-sm leading-relaxed">{s.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-[#f7f3ed] rounded-2xl border border-[#e8e0d5] p-6 space-y-5">
              <div>
                <p className="text-xs font-semibold tracking-[0.2em] text-[#a09282] uppercase mb-0.5">Live example</p>
                <p className="text-xs text-[#a09282] italic">Animal Farm · What if Boxer refused the slaughterhouse?</p>
              </div>
              {SAMPLE_DEBATE.map((e, i) => (
                <div key={i} className="flex gap-3">
                  <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-bold mt-0.5" style={{ backgroundColor: e.col }}>
                    {e.char[0]}
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-0.5" style={{ color: e.col }}>{e.char}</p>
                    <p className="text-[#6b5c4e] text-sm leading-relaxed">{e.line}</p>
                  </div>
                </div>
              ))}
              <p className="text-xs text-[#c8b89a] italic text-center pt-1">...debate continues until a new ending emerges</p>
            </div>
          </div>
        </div>

      </section>

      <footer className="bg-white border-t border-[#e8e0d5] py-5 text-center text-xs text-[#c8b89a]">
        WhatIfSabha — multi-agent story engine
      </footer>
    </main>
  );
}
