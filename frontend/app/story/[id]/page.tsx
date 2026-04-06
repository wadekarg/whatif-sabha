"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

const API = "http://localhost:8001";

const STAGE_STEPS = ["uploaded", "analyzing", "researching"];

type ChatMsg = { role: "user" | "assistant"; content: string };

export default function StoryPage() {
  const { id } = useParams<{ id: string }>();
  const [story, setStory]           = useState<any>(null);
  const [status, setStatus]         = useState("loading");
  const [pastDebates, setPastDebates] = useState<any[]>([]);
  const [whatIf, setWhatIf]         = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [overview, setOverview]     = useState<any>(null);

  // Chat state
  const [messages, setMessages]     = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API}/stories/${id}/status`);
        const data = await res.json();
        setStatus(data.status);
        if (data.status === "ready") {
          const [sr, dr, sgr] = await Promise.all([
            fetch(`${API}/stories/${id}`),
            fetch(`${API}/stories/${id}/debates`),
            fetch(`${API}/stories/${id}/divergence-points`),
          ]);
          setStory(await sr.json());
          setPastDebates(await dr.json());
          const sg = await sgr.json();
          if (Array.isArray(sg)) setSuggestions(sg);
          // Fetch overview independently so a failure doesn't break the page
          fetch(`${API}/stories/${id}/overview`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data) setOverview(data); })
            .catch(() => {});
        } else if (data.status === "error") {
          setStatus("error");
        } else {
          setTimeout(poll, 2500);
        }
      } catch { setTimeout(poll, 3000); }
    };
    poll();
  }, [id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatLoading]);

  const sendMessage = async () => {
    const q = chatInput.trim();
    if (!q || chatLoading) return;
    setChatInput("");
    const userMsg: ChatMsg = { role: "user", content: q };
    setMessages(prev => [...prev, userMsg]);
    setChatLoading(true);
    try {
      const res = await fetch(`${API}/stories/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history: messages }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: "assistant", content: data.answer }]);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Sorry, something went wrong. Please try again." }]);
    } finally {
      setChatLoading(false);
    }
  };

  const stageInfo: Record<string, { label: string; sub: string; icon: string }> = {
    loading:     { label: "Connecting...",               sub: "",                                                          icon: "⋯" },
    uploaded:    { label: "Extracting text...",          sub: "Reading story content from PDF",                           icon: "📄" },
    analyzing:   { label: "Analyzing story...",          sub: "Identifying characters, events, divergence points",        icon: "🔬" },
    researching: { label: "Researching characters...",  sub: "Wikipedia · web analysis · 3 independent AI perspectives", icon: "🔍" },
    error:       { label: "Analysis failed",             sub: "Please try again",                                          icon: "✕" },
  };

  if (status !== "ready" || !story) {
    const s = stageInfo[status] || { label: status, sub: "", icon: "⋯" };
    const currentStep = STAGE_STEPS.indexOf(status);
    return (
      <main className="flex-1 flex items-center justify-center p-8 bg-[#f7f3ed]">
        <div className="text-center space-y-7 max-w-sm px-6 animate-fade-up bg-white rounded-3xl p-12 shadow-sm border border-[#e8e0d5]">
          <div className={`text-5xl ${status !== "error" ? "animate-breathe" : ""}`}>{s.icon}</div>
          {status === "error" ? (
            <div className="text-red-500 text-lg font-medium">{s.label}</div>
          ) : (
            <>
              <div>
                <div className="text-[#c07820] text-xl font-semibold">{s.label}</div>
                {s.sub && <div className="text-[#a09282] text-sm mt-1 leading-relaxed">{s.sub}</div>}
              </div>
              <div className="flex items-center gap-2 justify-center">
                {STAGE_STEPS.map((step, i) => (
                  <div key={step} className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full transition-all duration-500 ${
                      i < currentStep   ? "bg-[#f0c060]" :
                      i === currentStep ? "bg-[#c07820] scale-125 shadow-[0_0_8px_rgba(192,120,32,0.5)]" :
                      "bg-[#e8e0d5]"
                    }`} />
                    {i < STAGE_STEPS.length - 1 && (
                      <div className={`w-8 h-px transition-colors duration-500 ${i < currentStep ? "bg-[#f0c060]" : "bg-[#e8e0d5]"}`} />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="flex overflow-hidden bg-[#f7f3ed]" style={{ height: "calc(100vh - 56px)" }}>

      {/* ── Left: story content ── */}
      <div className="flex-1 overflow-y-auto">
        {/* Hero */}
        <div className="bg-white border-b border-[#e8e0d5]">
          <div className="max-w-3xl mx-auto px-10 py-10">
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-3 flex-1">
                <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight text-[#1c1410]">
                  {story.title}
                </h1>
                {story.author && (
                  <p className="text-[#a09282] text-lg">
                    by <span className="text-[#6b5c4e] italic">{story.author}</span>
                  </p>
                )}
                <div className="flex gap-2 flex-wrap pt-1">
                  {(story.themes || []).map((t: string) => (
                    <span key={t} className="text-xs bg-[#fef3e2] border border-[#f0c060]/50 text-[#c07820] px-3 py-1 rounded-full font-medium">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              {story.word_count && (
                <div className="text-right shrink-0 hidden sm:block">
                  <div className="text-3xl font-bold text-[#1c1410]">{Math.round(story.word_count / 1000)}k</div>
                  <div className="text-xs text-[#a09282] uppercase tracking-widest mt-0.5">words</div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-10 py-8 space-y-8">
          {/* Summary */}
          {story.summary && (
            <div className="bg-white rounded-2xl p-6 border border-[#e8e0d5] flex gap-4">
              <div className="w-1 self-stretch bg-[#c07820] rounded-full shrink-0" />
              <div>
                <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-medium">Summary</div>
                <p className="text-[#6b5c4e] leading-relaxed">{story.summary}</p>
              </div>
            </div>
          )}

          {/* What If section */}
          <div className="bg-white rounded-2xl border-2 border-[#e8e0d5] focus-within:border-[#c07820] transition-colors overflow-hidden">
            <div className="px-6 pt-5 pb-2">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">⚡</span>
                <span className="text-sm font-bold text-[#1c1410]">What if...</span>
                <span className="text-xs text-[#a09282]">— describe your alternate scenario</span>
              </div>
              <textarea
                value={whatIf}
                onChange={(e) => setWhatIf(e.target.value)}
                placeholder="What if Boxer refused to go to the slaughterhouse and led a revolt against Napoleon?"
                rows={3}
                className="w-full bg-transparent resize-none text-[#1c1410] placeholder-[#c8b89a] focus:outline-none text-sm leading-relaxed"
              />
            </div>

            {suggestions.length > 0 && (
              <div className="px-6 pb-3 flex flex-wrap gap-2">
                {suggestions.map((s: any) => (
                  <button
                    key={s.event_id}
                    onClick={() => setWhatIf(s.description)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                      whatIf === s.description
                        ? "bg-[#fef3e2] border-[#f0c060] text-[#c07820] font-medium"
                        : "bg-[#f7f3ed] border-[#e8e0d5] text-[#6b5c4e] hover:border-[#c07820]/40 hover:bg-[#fef3e2]/60"
                    }`}
                  >
                    → {s.description}
                  </button>
                ))}
              </div>
            )}

            <div className="px-6 py-3 bg-[#faf7f2] border-t border-[#e8e0d5] flex items-center justify-between">
              <span className="text-xs text-[#a09282]">
                {whatIf.trim() ? `${whatIf.length} chars` : "Pick a suggestion or write your own"}
              </span>
              <a
                href={whatIf.trim() ? `/story/${id}/debate?q=${encodeURIComponent(whatIf.trim())}` : `/story/${id}/debate`}
                className={`flex items-center gap-1.5 text-sm font-bold px-5 py-2 rounded-xl transition-all ${
                  whatIf.trim()
                    ? "bg-[#c07820] hover:bg-[#a86a18] text-white shadow-sm"
                    : "bg-[#e8e0d5] text-[#a09282] cursor-default"
                }`}
                onClick={(e) => { if (!whatIf.trim()) e.preventDefault(); }}
              >
                <span>⚡</span> Begin Sabha
              </a>
            </div>
          </div>

          {/* Action cards */}
          <div className="grid grid-cols-3 gap-5">
            <Link
              href={`/story/${id}/characters`}
              className="group bg-white hover:bg-[#faf7f2] border border-[#e8e0d5] hover:border-[#c8b89a] rounded-2xl p-7 text-center transition-all duration-200 space-y-3"
            >
              <div className="text-4xl group-hover:scale-110 transition-transform duration-200">👥</div>
              <div className="font-semibold text-[#1c1410]">Characters</div>
              <div className="text-[#a09282] text-sm">Profiles · Fair Witness</div>
            </Link>

            <Link
              href={`/story/${id}/graph`}
              className="group bg-white hover:bg-[#faf7f2] border border-[#e8e0d5] hover:border-[#c8b89a] rounded-2xl p-7 text-center transition-all duration-200 space-y-3"
            >
              <div className="text-4xl group-hover:scale-110 transition-transform duration-200">🕸️</div>
              <div className="font-semibold text-[#1c1410]">Relationship Graph</div>
              <div className="text-[#a09282] text-sm">Interactive force map</div>
            </Link>

            <Link
              href={`/story/${id}/debate`}
              className="group bg-white hover:bg-[#faf7f2] border border-[#e8e0d5] hover:border-[#c8b89a] rounded-2xl p-7 text-center transition-all duration-200 space-y-3"
            >
              <div className="text-4xl group-hover:scale-110 transition-transform duration-200">🕰️</div>
              <div className="font-semibold text-[#1c1410]">Past Debates</div>
              <div className="text-[#a09282] text-sm">View all alternate endings</div>
            </Link>
          </div>

          {/* Past debates */}
          {pastDebates.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="text-xs text-[#a09282] uppercase tracking-widest font-medium">Past Debates</div>
                <div className="flex-1 h-px bg-[#e8e0d5]" />
                <div className="text-xs text-[#a09282] bg-[#f0ebe4] px-2 py-0.5 rounded-full">{pastDebates.length}</div>
              </div>
              {pastDebates.map((d: any, i: number) => (
                <Link
                  key={d.id}
                  href={`/story/${id}/debate/${d.id}`}
                  className="group block bg-white hover:bg-[#faf7f2] border border-[#e8e0d5] hover:border-[#c8b89a] rounded-xl p-4 transition-all duration-200"
                >
                  <div className="flex items-start gap-3">
                    <div className="text-[#c8b89a] text-sm font-mono mt-0.5 w-5 shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[#6b5c4e] text-sm leading-relaxed group-hover:text-[#1c1410] transition-colors line-clamp-2">
                        {d.divergence_description}
                      </p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-[#a09282]">
                        <span>{d.round_count} rounds</span>
                        <span>·</span>
                        <span className="truncate">
                          {(d.participating_characters || []).slice(0, 4).join(", ")}
                          {(d.participating_characters || []).length > 4 ? "…" : ""}
                        </span>
                      </div>
                    </div>
                    <span className={`text-xs px-2.5 py-0.5 rounded-full border shrink-0 font-medium ${
                      d.status === "completed"
                        ? "border-emerald-200 text-emerald-700 bg-emerald-50"
                        : "border-[#e8e0d5] text-[#a09282] bg-[#f7f3ed]"
                    }`}>
                      {d.status === "completed" ? "✓ done" : d.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* ── Orchestrator view ── */}
          {overview && (
            <div className="space-y-8 pb-8">

              {/* Section divider */}
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">✦</div>
                <div className="text-sm font-semibold text-[#1c1410]">Orchestrator's View</div>
                <div className="flex-1 h-px bg-[#e8e0d5]" />
              </div>

              {/* Narrative arc — phases derived from the protagonist's arc */}
              {(() => {
                const protagonist = overview.character_arcs?.find((a: any) => a.role === "protagonist") || overview.character_arcs?.[0];
                if (!protagonist?.phases?.length) return null;
                return (
                  <div className="bg-[#1c1410] rounded-2xl p-6 space-y-4">
                    <div className="flex items-center gap-2">
                      <span className="text-[#c07820] text-xs font-semibold uppercase tracking-widest">Narrative Arc</span>
                      <span className="text-white/20 text-xs">· {protagonist.phases.length} phases</span>
                    </div>
                    {/* Horizontal phase bar */}
                    <div className="flex items-start gap-0 overflow-x-auto pb-1">
                      {protagonist.phases.map((p: any, pi: number) => (
                        <div key={pi} className="flex items-start shrink-0 flex-1 min-w-[80px]">
                          <div className="flex-1">
                            <div className="flex items-center">
                              <div className={`w-3 h-3 rounded-full shrink-0 ${pi === 0 ? "bg-[#c07820]" : pi === protagonist.phases.length - 1 ? "bg-red-500" : "bg-white/30"}`} />
                              {pi < protagonist.phases.length - 1 && (
                                <div className="flex-1 h-px bg-white/10 mx-1" />
                              )}
                            </div>
                            <div className="mt-2 pr-2">
                              <div className="text-[10px] text-white/40 uppercase tracking-wider font-medium">
                                {p.phase_id?.replace(/_/g, " ") || `Phase ${pi + 1}`}
                              </div>
                              {p.emotional_state && (
                                <div className="text-xs text-white/65 mt-0.5 leading-snug">{p.emotional_state}</div>
                              )}
                              {p.motivations?.[0] && (
                                <div className="text-[10px] text-white/30 mt-1 leading-snug italic">"{p.motivations[0]}"</div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* All characters' arc overview */}
                    {overview.character_arcs?.length > 1 && (
                      <div className="border-t border-white/10 pt-4 space-y-2">
                        <div className="text-[10px] text-white/25 uppercase tracking-widest font-medium mb-3">All Characters</div>
                        {overview.character_arcs.map((arc: any) => (
                          <div key={arc.name} className="flex items-center gap-3">
                            <div className="w-24 shrink-0">
                              <span className={`text-xs font-medium ${
                                arc.role === "protagonist" ? "text-[#c07820]" :
                                arc.role === "antagonist" ? "text-red-400" : "text-white/50"
                              }`}>{arc.name}</span>
                            </div>
                            <div className="flex-1 flex items-center gap-1">
                              {arc.phases.map((_: any, pi: number) => (
                                <div key={pi} className={`h-1.5 flex-1 rounded-full ${
                                  arc.role === "protagonist" ? "bg-[#c07820]/60" :
                                  arc.role === "antagonist" ? "bg-red-500/50" : "bg-white/15"
                                }`} />
                              ))}
                            </div>
                            <span className="text-[10px] text-white/20 w-12 text-right">{arc.phases.length} phases</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Key power dynamics */}
              {overview.relationships?.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs text-[#a09282] uppercase tracking-widest font-medium">Power Dynamics</div>
                  <div className="grid grid-cols-2 gap-3">
                    {overview.relationships
                      .filter((r: any) => ["controls", "rivals", "enemies", "mentor", "ally"].includes(r.type))
                      .slice(0, 6)
                      .map((r: any, i: number) => (
                        <div key={i} className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className="font-semibold text-sm text-[#1c1410]">{r.from}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
                              r.type === "enemies"  || r.type === "rivals"  ? "text-red-600 bg-red-50 border-red-200" :
                              r.type === "controls"                          ? "text-purple-700 bg-purple-50 border-purple-200" :
                              r.type === "mentor"                            ? "text-blue-700 bg-blue-50 border-blue-200" :
                              "text-emerald-700 bg-emerald-50 border-emerald-200"
                            }`}>{r.type}</span>
                            <span className="font-semibold text-sm text-[#1c1410]">{r.to}</span>
                          </div>
                          {r.description && <p className="text-xs text-[#a09282] leading-relaxed">{r.description}</p>}
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Story timeline */}
              {overview.knowledge_events?.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs text-[#a09282] uppercase tracking-widest font-medium">
                    Story Timeline
                    <span className="ml-2 text-[#c8b89a] normal-case tracking-normal font-normal">— {overview.knowledge_events.length} key moments</span>
                  </div>
                  <div className="relative">
                    <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gradient-to-b from-[#c07820] via-[#e8e0d5] to-[#e8e0d5]" />
                    <div className="space-y-2">
                      {overview.knowledge_events.map((e: any, i: number) => (
                        <div key={i} className="flex gap-4 pl-1">
                          <div className={`w-3.5 h-3.5 rounded-full shrink-0 mt-1 z-10 border-2 ${
                            i === 0 ? "border-[#c07820] bg-[#fef3e2]" : "border-[#c8b89a] bg-white"
                          }`} />
                          <div className="bg-white border border-[#e8e0d5] rounded-xl p-4 flex-1">
                            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                              <span className="text-[10px] font-semibold text-[#c07820] uppercase tracking-wider">{e.character}</span>
                              {i === 0 && <span className="text-[10px] text-[#c07820] bg-[#fef3e2] border border-[#f0c060]/50 px-2 py-0.5 rounded-full">Opening</span>}
                              {i === overview.knowledge_events.length - 1 && <span className="text-[10px] text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">Climax</span>}
                            </div>
                            <div className="font-medium text-sm text-[#1c1410]">{e.event}</div>
                            {e.impact && <div className="text-[#a09282] text-xs mt-1.5 leading-relaxed">{e.impact}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Divergence points */}
              {overview.divergence_points?.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs text-[#a09282] uppercase tracking-widest font-medium">
                    Moments That Could Change Everything
                    <span className="ml-2 text-[#c8b89a] normal-case tracking-normal font-normal">— click to start a debate</span>
                  </div>
                  <div className="space-y-2">
                    {overview.divergence_points.map((d: any, i: number) => (
                      <button key={i} onClick={() => setWhatIf(d.description)}
                        className={`group w-full text-left bg-white border rounded-xl p-4 transition-all duration-200 ${
                          whatIf === d.description ? "border-[#c07820] bg-[#fef3e2]/50 shadow-sm" : "border-[#e8e0d5] hover:border-[#c07820]/40 hover:bg-[#fef3e2]/20"
                        }`}>
                        <div className="flex items-start gap-3">
                          <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 mt-0.5 font-bold transition-colors ${
                            whatIf === d.description ? "bg-[#c07820] text-white" : "bg-[#fef3e2] text-[#c07820] group-hover:bg-[#c07820] group-hover:text-white"
                          }`}>{i + 1}</div>
                          <div className="flex-1">
                            <p className="text-sm text-[#1c1410] font-medium leading-relaxed">{d.description}</p>
                            {d.affected_characters?.length > 0 && (
                              <div className="flex gap-1.5 flex-wrap mt-2">
                                {d.affected_characters.map((c: string) => (
                                  <span key={c} className="text-[10px] px-2 py-0.5 rounded-full bg-[#f7f3ed] border border-[#e8e0d5] text-[#6b5c4e]">{c}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          <span className={`text-xs shrink-0 mt-0.5 transition-colors ${whatIf === d.description ? "text-[#c07820]" : "text-[#c8b89a] group-hover:text-[#c07820]"}`}>⚡</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

        </div>
      </div>

      {/* ── Right: story chat ── */}
      <div className="w-[460px] shrink-0 border-l border-[#e8e0d5] bg-white flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#e8e0d5] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-sm">✦</div>
            <div>
              <div className="font-semibold text-[#1c1410] text-sm">Ask about the story</div>
              <div className="text-[#a09282] text-xs">Characters · events · what-ifs</div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-[#a09282] text-xs text-center mb-4">Ask anything about {story.title}</p>
              {[
                "Who is the main antagonist and why?",
                "What are the key themes of this story?",
                "How do the characters relate to each other?",
                "What would happen if the ending changed?",
              ].map(q => (
                <button
                  key={q}
                  onClick={() => { setChatInput(q); }}
                  className="w-full text-left text-xs text-[#6b5c4e] bg-[#f7f3ed] hover:bg-[#fef3e2] border border-[#e8e0d5] hover:border-[#f0c060]/50 px-3 py-2.5 rounded-xl transition-colors leading-relaxed"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && (
                <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs shrink-0 mr-2 mt-0.5">✦</div>
              )}
              <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-[#c07820] text-white rounded-br-sm"
                  : "bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] rounded-bl-sm"
              }`}>
                {m.role === "assistant" ? (
                <ReactMarkdown components={{
                  p: ({children}) => <p className="mb-1 last:mb-0">{children}</p>,
                  strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                  h3: ({children}) => <p className="font-semibold mt-2 mb-0.5">{children}</p>,
                  h2: ({children}) => <p className="font-semibold mt-2 mb-0.5">{children}</p>,
                  ul: ({children}) => <ul className="list-disc list-outside pl-4 space-y-0.5">{children}</ul>,
                  ol: ({children}) => <ol className="list-decimal list-outside pl-4 space-y-0.5">{children}</ol>,
                  li: ({children}) => <li>{children}</li>,
                }}>{typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as {text?:string}[]).map(b => b?.text ?? "").join("") : String(m.content)}</ReactMarkdown>
              ) : (
                typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as {text?:string}[]).map(b => b?.text ?? "").join("") : String(m.content)
              )}
              </div>
            </div>
          ))}

          {chatLoading && (
            <div className="flex justify-start">
              <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs shrink-0 mr-2 mt-0.5">✦</div>
              <div className="bg-[#f7f3ed] border border-[#e8e0d5] px-4 py-3 rounded-2xl rounded-bl-sm">
                <div className="flex gap-1.5 items-center h-4">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay: "300ms" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay: "600ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-[#e8e0d5] shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Ask about characters, plot, themes…"
              rows={2}
              className="flex-1 resize-none bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-xl px-3.5 py-2.5 text-sm text-[#1c1410] placeholder-[#c8b89a] focus:outline-none leading-relaxed transition-colors"
            />
            <button
              onClick={sendMessage}
              disabled={!chatInput.trim() || chatLoading}
              className="w-10 h-10 rounded-xl bg-[#c07820] hover:bg-[#a86a18] disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white flex items-center justify-center transition-colors shrink-0 text-lg"
            >
              ↑
            </button>
          </div>
          <p className="text-[#c8b89a] text-[10px] mt-1.5">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>

    </main>
  );
}
