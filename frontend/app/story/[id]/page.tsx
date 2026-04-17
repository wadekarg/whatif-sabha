"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { API } from "../../config";

const STAGE_STEPS = ["uploaded", "analyzing", "researching"];

type ChatMsg = { role: "user" | "assistant"; content: string };

const CHAR_COLORS = [
  "#c07820","#3b82f6","#10b981","#a855f7","#ec4899","#06b6d4","#f97316","#ef4444",
];

export default function StoryPage() {
  const { id } = useParams<{ id: string }>();
  const [story, setStory]           = useState<any>(null);
  const [status, setStatus]         = useState("loading");
  const [pastDebates, setPastDebates] = useState<any[]>([]);
  const [whatIf, setWhatIf]         = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [overview, setOverview]     = useState<any>(null);
  const [storyCharacters, setStoryCharacters] = useState<any[]>([]);

  // Right panel tab: "story" | "character"
  const [rightTab, setRightTab]     = useState<"story" | "character">("story");

  // Story chat state
  const [messages, setMessages]     = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Character chat state
  const [charChatCharacter, setCharChatCharacter] = useState<any>(null);
  const [charMessages, setCharMessages] = useState<ChatMsg[]>([]);
  const [charInput, setCharInput]   = useState("");
  const [charLoading, setCharLoading] = useState(false);
  const [charStreaming, setCharStreaming] = useState("");
  const charChatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    charChatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [charMessages, charStreaming]);

  const sendCharMessage = async () => {
    const q = charInput.trim();
    if (!q || charLoading || !charChatCharacter) return;
    setCharInput("");
    setCharMessages(prev => [...prev, { role: "user", content: q }]);
    setCharLoading(true);
    setCharStreaming("");
    try {
      const res = await fetch(
        `${API}/stories/${id}/characters/${encodeURIComponent(charChatCharacter.name)}/chat/stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, history: charMessages }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let full = "";
      let gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "token") { full += ev.text; setCharStreaming(full); }
            if (ev.type === "error") { full = ev.message || "Could not reach this character."; }
            if (ev.type === "done") {
              setCharMessages(prev => [...prev, { role: "assistant", content: full || "…" }]);
              setCharStreaming("");
              gotDone = true;
            }
          } catch (e) { console.error("Failed to parse SSE event:", e); }
        }
      }
      if (!gotDone) {
        setCharMessages(prev => [...prev, { role: "assistant", content: full || "Could not reach this character." }]);
        setCharStreaming("");
      }
    } catch (e) {
      console.error("Character chat error:", e);
      setCharMessages(prev => [...prev, { role: "assistant", content: "Could not reach this character right now." }]);
      setCharStreaming("");
    } finally {
      setCharLoading(false);
    }
  };

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`${API}/stories/${id}/status`);
        if (!res.ok) { if (!stopped) setTimeout(poll, 3000); return; }
        const data = await res.json();
        if (stopped) return;
        setStatus(data.status);
        if (data.status === "ready") {
          const [sr, dr, sgr, cr] = await Promise.all([
            fetch(`${API}/stories/${id}`),
            fetch(`${API}/stories/${id}/debates`),
            fetch(`${API}/stories/${id}/divergence-points`),
            fetch(`${API}/stories/${id}/characters`),
          ]);
          if (sr.ok) setStory(await sr.json());
          if (dr.ok) setPastDebates(await dr.json());
          if (sgr.ok) { const sg = await sgr.json(); if (Array.isArray(sg)) setSuggestions(sg); }
          if (cr.ok) { const chars = await cr.json(); if (Array.isArray(chars)) setStoryCharacters(chars); }
          fetch(`${API}/stories/${id}/overview`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data) setOverview(data); })
            .catch(() => {});
        } else if (data.status === "error") {
          setStatus("error");
        } else {
          if (!stopped) setTimeout(poll, 2500);
        }
      } catch (e) { console.error("Poll error:", e); if (!stopped) setTimeout(poll, 3000); }
    };
    poll();
    return () => { stopped = true; };
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
    } catch (e) {
      console.error("Chat error:", e);
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

        {/* ── HERO ── */}
        <div className="px-8 lg:px-14 pt-6 pb-0">
          <div className="bg-white rounded-2xl border border-[#e8e0d5] overflow-hidden">
            {/* Info section */}
            <div className="px-6 pt-6 pb-5 space-y-4">
              {/* Title */}
              <h1 className="text-4xl lg:text-5xl font-bold tracking-tight leading-tight text-[#1c1410]">
                {story.title}
              </h1>

              {/* Meta row: author + word count + themes */}
              <div className="flex flex-wrap items-center gap-3">
                {story.author && (
                  <span className="text-sm text-[#a09282]">
                    by <span className="text-[#6b5c4e] italic">{story.author}</span>
                  </span>
                )}
                {story.author && story.word_count && <span className="text-[#d4c4a8]">·</span>}
                {story.word_count && (
                  <span className="text-sm text-[#a09282]">
                    <span className="font-semibold text-[#6b5c4e]">{Math.round(story.word_count / 1000)}k</span> words
                  </span>
                )}
                {((story.author || story.word_count) && (story.themes || []).length > 0) && <span className="text-[#d4c4a8]">·</span>}
                {(story.themes || []).map((t: string) => (
                  <span key={t} className="text-xs bg-[#fef3e2] border border-[#f0c060]/50 text-[#c07820] px-3 py-1 rounded-full font-medium">{t}</span>
                ))}
              </div>

              {/* Summary */}
              {story.summary && (
                <p className="text-[#6b5c4e] leading-relaxed text-sm">{story.summary}</p>
              )}

              {/* Nav pills */}
              <div className="flex items-center gap-2">
                <Link href={`/story/${id}/characters`}
                  className="text-xs px-3 py-1.5 rounded-full border border-[#e8e0d5] bg-[#f7f3ed] text-[#6b5c4e] hover:border-[#c8b89a] hover:bg-white transition-colors font-medium">
                  🎭 {storyCharacters.length > 0 ? `${storyCharacters.length} Characters` : "Characters"}
                </Link>
                <Link href={`/story/${id}/debate`}
                  className="text-xs px-3 py-1.5 rounded-full border border-[#e8e0d5] bg-[#f7f3ed] text-[#6b5c4e] hover:border-[#c8b89a] hover:bg-white transition-colors font-medium">
                  ⚡ Sabha
                </Link>
              </div>
            </div>

            {/* Character cast strip */}
            {storyCharacters.length > 0 && (
              <div className="px-6 pb-5 border-t border-[#f0ece5]">
                <div className="flex items-center gap-2 py-3">
                  <span className="text-xs text-[#a09282] uppercase tracking-widest font-medium">Cast</span>
                  <div className="flex-1 h-px bg-[#f0ece5]" />
                  <Link href={`/story/${id}/characters`} className="text-xs text-[#c07820] hover:underline font-medium">See all →</Link>
                </div>
                <div className="flex gap-5 overflow-x-auto pb-1">
                  {storyCharacters.slice(0, 14).map((char: any, i: number) => {
                    const col = CHAR_COLORS[i % CHAR_COLORS.length];
                    const roleColor: Record<string, string> = { protagonist: "#c07820", antagonist: "#ef4444", supporting: "#3b82f6" };
                    return (
                      <Link key={`${i}-${char.name}`} href={`/story/${id}/characters/${encodeURIComponent(char.name).replace(/\./g, "%2E")}`}
                        className="flex flex-col items-center gap-1.5 shrink-0 group">
                        {char.portrait ? (
                          <img src={`${API}${char.portrait}`} alt={char.name} loading="lazy"
                            className="w-12 h-12 rounded-full object-cover shadow-sm group-hover:scale-110 group-hover:shadow-md transition-all duration-200 ring-2 ring-white"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base shadow-sm group-hover:scale-110 group-hover:shadow-md transition-all duration-200 ring-2 ring-white"
                            style={{ backgroundColor: col }}>
                            {char.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <span className="text-xs font-semibold text-[#6b5c4e] group-hover:text-[#1c1410] transition-colors text-center leading-none">{char.name.split(" ")[0]}</span>
                        {char.role && (
                          <span className="text-[10px] font-medium capitalize" style={{ color: roleColor[char.role] || "#a09282" }}>{char.role}</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── WHAT IF — primary CTA ── */}
        <div className="px-8 lg:px-14 py-6">
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
            <div className="px-6 pb-3 flex flex-wrap gap-2">
              {suggestions.map((s: any, i: number) => (
                <button key={s.event_id || i} onClick={() => setWhatIf(s.description)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                    whatIf === s.description
                      ? "bg-[#fef3e2] border-[#f0c060] text-[#c07820] font-medium"
                      : "bg-[#f7f3ed] border-[#e8e0d5] text-[#6b5c4e] hover:border-[#c07820]/40 hover:bg-[#fef3e2]/60"
                  }`}>
                  → {s.description}
                </button>
              ))}
              <button
                onClick={async () => {
                  const res = await fetch(`${API}/stories/${id}/divergence-points/generate`, { method: "POST" });
                  if (res.ok) { const data = await res.json(); if (Array.isArray(data)) setSuggestions(data); }
                }}
                className="text-xs px-3 py-1.5 rounded-full border border-dashed border-[#c07820]/40 text-[#c07820] hover:bg-[#fef3e2]/60 transition-all"
              >
                + More ideas
              </button>
            </div>
            <div className="px-6 py-3 bg-[#faf7f2] border-t border-[#e8e0d5] flex items-center justify-between">
              <span className="text-xs text-[#a09282]">
                {whatIf.trim() ? `${whatIf.length} chars` : "Pick a suggestion or write your own"}
              </span>
              <a
                href={whatIf.trim() ? `/story/${id}/debate?q=${encodeURIComponent(whatIf.trim())}` : `/story/${id}/debate`}
                className={`flex items-center gap-1.5 text-sm font-bold px-5 py-2 rounded-xl transition-all ${
                  whatIf.trim() ? "bg-[#c07820] hover:bg-[#a86a18] text-white shadow-sm" : "bg-[#e8e0d5] text-[#a09282] cursor-default"
                }`}
                onClick={(e) => { if (!whatIf.trim()) e.preventDefault(); }}
              >
                <span>⚡</span> Begin Sabha
              </a>
            </div>
          </div>
        </div>

        {/* ── PAST DEBATES ── */}
        {pastDebates.length > 0 ? (
          <DebateList
            debates={pastDebates}
            storyId={id}
            onDelete={(debateId: string) => setPastDebates(prev => prev.filter((d: any) => d.id !== debateId))}
          />
        ) : overview ? (
          <div className="px-8 lg:px-14 pb-6">
            <div className="text-center py-8 bg-white rounded-2xl border border-[#e8e0d5]">
              <p className="text-sm text-[#a09282]">No debates yet</p>
              <p className="text-xs text-[#c8b89a] mt-1">Use the "What if..." box above to start your first Sabha</p>
            </div>
          </div>
        ) : null}

        {/* ── STORY INTELLIGENCE ── */}
        {overview && (
          <div className="px-8 lg:px-14 pb-10 space-y-8">

            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">✦</div>
              <div className="text-sm font-semibold text-[#1c1410]">Story Intelligence</div>
              <div className="flex-1 h-px bg-[#e8e0d5]" />
            </div>

            {/* Narrative arc — light warm theme */}
            {(() => {
              const protagonist = overview.character_arcs?.find((a: any) => a.role === "protagonist") || overview.character_arcs?.[0];
              if (!protagonist?.phases?.length) return null;
              return (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#a09282] uppercase tracking-widest font-semibold">Narrative Arc</span>
                    <span className="text-[#c8b89a] text-xs">· {protagonist.phases.length} phases</span>
                  </div>
                  {/* Phase cards — horizontal scroll */}
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {protagonist.phases.map((p: any, pi: number) => {
                      const isFirst = pi === 0;
                      const isLast = pi === protagonist.phases.length - 1;
                      return (
                        <div key={pi} className="flex items-start shrink-0 gap-2" style={{ minWidth: 160, maxWidth: 200 }}>
                          <div className="flex flex-col items-center pt-2 shrink-0">
                            <div className={`w-3 h-3 rounded-full border-2 ${isFirst ? "bg-[#c07820] border-[#c07820]" : isLast ? "bg-red-400 border-red-300" : "bg-[#e8e0d5] border-[#c8b89a]"}`} />
                            {pi < protagonist.phases.length - 1 && (
                              <div className="w-px flex-1 bg-[#e8e0d5] mt-1" style={{ minHeight: 20 }} />
                            )}
                          </div>
                          <div className={`flex-1 rounded-xl border p-3 ${isFirst ? "bg-[#fef9f0] border-[#f0c060]/50" : isLast ? "bg-red-50/60 border-red-200/60" : "bg-white border-[#e8e0d5]"}`}>
                            <div className={`text-xs font-semibold uppercase tracking-wide mb-1 ${isFirst ? "text-[#c07820]" : isLast ? "text-red-500" : "text-[#a09282]"}`}>
                              {p.phase_id?.replace(/_/g, " ") || `Phase ${pi + 1}`}
                            </div>
                            {p.emotional_state && <div className="text-xs text-[#6b5c4e] leading-snug">{p.emotional_state}</div>}
                            {p.motivations?.[0] && <div className="text-xs text-[#a09282] mt-1 leading-snug italic">"{p.motivations[0]}"</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
                            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${
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

              {/* Story Timeline — merged phases + key events + knowledge events */}
              {(() => {
                const phases: any[] = overview.timeline_phases || [];
                const keyEvents: any[] = (overview.key_events || []).map((e: any) => ({ ...e, _type: "event" }));
                const revelations: any[] = (overview.knowledge_events || []).map((e: any) => ({ ...e, _type: "revelation", timeline_position: e.timeline_position ?? 0.5 }));
                const allItems = [...keyEvents, ...revelations].sort((a, b) => (a.timeline_position ?? 0) - (b.timeline_position ?? 0));
                if (!allItems.length && !phases.length) return null;

                // Assign each item to a phase
                const getPhase = (pos: number) => phases.find((p: any) => pos >= (p.timeline_position_start ?? 0) && pos <= (p.timeline_position_end ?? 1)) || null;

                // Build phase-grouped structure
                const groups: { phase: any; items: any[] }[] = [];
                if (phases.length) {
                  phases.forEach((ph: any) => groups.push({ phase: ph, items: [] }));
                  allItems.forEach(item => {
                    const ph = getPhase(item.timeline_position ?? 0);
                    const grp = ph ? groups.find(g => g.phase.phase_id === ph.phase_id) : groups[0];
                    if (grp) grp.items.push(item);
                    else groups[groups.length - 1]?.items.push(item);
                  });
                } else {
                  groups.push({ phase: null, items: allItems });
                }

                const totalEvents = allItems.length;
                let globalIdx = 0;

                return (
                  <div className="space-y-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest font-medium">
                      Story Timeline
                      <span className="ml-2 text-[#c8b89a] normal-case tracking-normal font-normal">— {phases.length} phases · {totalEvents} moments</span>
                    </div>

                    <div className="relative">
                      {/* Vertical line */}
                      <div className="absolute left-[11px] top-0 bottom-0 w-0.5 bg-gradient-to-b from-[#c07820] via-[#c8b89a]/40 to-[#e8e0d5]" />

                      <div className="space-y-1">
                        {groups.map((grp, gi) => (
                          <div key={gi}>
                            {/* Phase header */}
                            {grp.phase && (
                              <div className="flex gap-4 items-center mb-3 mt-4 first:mt-0">
                                <div className="w-6 h-6 rounded-lg bg-[#c07820] flex items-center justify-center text-white text-xs font-bold shrink-0 z-10">{gi + 1}</div>
                                <div className="flex-1 bg-[#fef9f0] border border-[#f0c060]/40 rounded-xl px-4 py-2.5">
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <span className="text-[#c07820] text-xs font-semibold uppercase tracking-wide">
                                      {grp.phase.name || grp.phase.phase_id?.replace(/_/g, " ")}
                                    </span>
                                    {grp.phase.chapter_range && (
                                      <span className="text-[#a09282] text-xs">
                                        Ch. {grp.phase.chapter_range[0]}{grp.phase.chapter_range[1] !== grp.phase.chapter_range[0] ? `–${grp.phase.chapter_range[1]}` : ""}
                                      </span>
                                    )}
                                  </div>
                                  {grp.phase.description && (
                                    <p className="text-[#6b5c4e] text-xs mt-0.5 leading-relaxed">{grp.phase.description}</p>
                                  )}
                                  {grp.phase.trigger_event && (
                                    <p className="text-[#c07820]/70 text-xs mt-1 italic">Triggered by: {grp.phase.trigger_event}</p>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Events in this phase */}
                            <div className="space-y-2 pl-0">
                              {grp.items.map((item: any, ii: number) => {
                                const idx = globalIdx++;
                                const isFirst = idx === 0;
                                const isLast = idx === totalEvents - 1;
                                const isTurning = item._type === "event" && item.is_turning_point;
                                const isRevelation = item._type === "revelation";

                                return (
                                  <div key={ii} className="flex gap-4 pl-0">
                                    {/* Node */}
                                    <div className={`w-6 h-6 rounded-full shrink-0 mt-0.5 z-10 flex items-center justify-center text-xs font-bold border-2 ${
                                      isFirst        ? "bg-[#fef3e2] border-[#c07820] text-[#c07820]" :
                                      isLast         ? "bg-red-50 border-red-400 text-red-500" :
                                      isTurning      ? "bg-purple-50 border-purple-400 text-purple-600" :
                                      isRevelation   ? "bg-blue-50 border-blue-300 text-blue-500" :
                                      "bg-white border-[#c8b89a] text-[#a09282]"
                                    }`}>
                                      {isFirst ? "▶" : isLast ? "✕" : isTurning ? "↻" : isRevelation ? "💡" : "·"}
                                    </div>

                                    {/* Card */}
                                    <div className={`flex-1 rounded-xl p-4 border mb-0 ${
                                      isTurning    ? "bg-purple-50/60 border-purple-200" :
                                      isRevelation ? "bg-blue-50/50 border-blue-200/70" :
                                      isFirst      ? "bg-[#fef9f0] border-[#f0c060]/50" :
                                      isLast       ? "bg-red-50/50 border-red-200" :
                                      "bg-white border-[#e8e0d5]"
                                    }`}>
                                      {/* Top row */}
                                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                                        {/* Type badge */}
                                        {isTurning && <span className="text-xs font-bold text-purple-700 bg-purple-100 border border-purple-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Turning Point</span>}
                                        {isRevelation && <span className="text-xs font-bold text-blue-700 bg-blue-100 border border-blue-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Revelation</span>}
                                        {isFirst && <span className="text-xs font-bold text-[#c07820] bg-[#fef3e2] border border-[#f0c060]/50 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Opening</span>}
                                        {isLast && <span className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Climax</span>}

                                        {/* Characters */}
                                        {item._type === "event" && item.characters_involved?.length > 0 && (
                                          <div className="flex gap-1 flex-wrap">
                                            {item.characters_involved.slice(0, 4).map((c: string) => (
                                              <span key={c} className="text-xs px-1.5 py-0.5 rounded-full bg-[#f7f3ed] border border-[#e8e0d5] text-[#6b5c4e]">{c}</span>
                                            ))}
                                          </div>
                                        )}
                                        {item._type === "revelation" && (
                                          <span className="text-xs text-[#c07820] font-semibold">
                                            {item.character}{item.from_character ? ` ← ${item.from_character}` : ""}
                                          </span>
                                        )}

                                        {/* Chapter */}
                                        {item.chapter && <span className="ml-auto text-xs text-[#c8b89a]">Ch. {item.chapter}</span>}
                                      </div>

                                      {/* Title / what happened */}
                                      <div className="font-semibold text-sm text-[#1c1410] leading-snug">
                                        {item._type === "event" ? (item.name || item.description) : item.learns}
                                      </div>

                                      {/* Description (for events with separate name+description) */}
                                      {item._type === "event" && item.name && item.description && item.name !== item.description && (
                                        <p className="text-xs text-[#6b5c4e] mt-1 leading-relaxed">{item.description}</p>
                                      )}

                                      {/* Consequence / impact */}
                                      {(item.consequence || item.impact_on_character) && (
                                        <div className="mt-2 flex gap-1.5 items-start">
                                          <span className="text-xs text-[#a09282] shrink-0 mt-px">→</span>
                                          <p className="text-xs text-[#a09282] leading-relaxed italic">{item.consequence || item.impact_on_character}</p>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}

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
                                  <span key={c} className="text-xs px-2 py-0.5 rounded-full bg-[#f7f3ed] border border-[#e8e0d5] text-[#6b5c4e]">{c}</span>
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

      {/* ── Right: tabbed panel ── */}
      <div className="w-[460px] shrink-0 border-l border-[#e8e0d5] bg-white flex flex-col">

        {/* Tab bar */}
        <div className="shrink-0 border-b border-[#e8e0d5] flex">
          <button
            onClick={() => setRightTab("story")}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-sm font-semibold transition-colors border-b-2 ${
              rightTab === "story"
                ? "text-[#c07820] border-[#c07820]"
                : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
            }`}
          >
            <span>✦</span> Ask the Story
          </button>
          <button
            onClick={() => setRightTab("character")}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-sm font-semibold transition-colors border-b-2 ${
              rightTab === "character"
                ? "text-[#c07820] border-[#c07820]"
                : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
            }`}
          >
            <span>◉</span> Talk to Characters
          </button>
        </div>

        {/* ── Story chat tab ── */}
        {rightTab === "story" && (
          <>
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
                    <button key={q} onClick={() => setChatInput(q)}
                      className="w-full text-left text-sm text-[#6b5c4e] bg-[#f7f3ed] hover:bg-[#fef3e2] border border-[#e8e0d5] hover:border-[#f0c060]/50 px-4 py-3 rounded-xl transition-colors leading-relaxed">
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
                    m.role === "user" ? "bg-[#c07820] text-white rounded-br-sm" : "bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] rounded-bl-sm"
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
                      }}>{typeof m.content === "string" ? m.content : String(m.content)}</ReactMarkdown>
                    ) : (
                      typeof m.content === "string" ? m.content : String(m.content)
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
            <div className="p-4 border-t border-[#e8e0d5] shrink-0">
              <div className="flex gap-2 items-end">
                <textarea value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder="Ask about characters, plot, themes…" rows={2}
                  className="flex-1 resize-none bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-xl px-3.5 py-2.5 text-sm text-[#1c1410] placeholder-[#c8b89a] focus:outline-none leading-relaxed transition-colors" />
                <button onClick={sendMessage} disabled={!chatInput.trim() || chatLoading}
                  className="w-10 h-10 rounded-xl bg-[#c07820] hover:bg-[#a86a18] disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white flex items-center justify-center transition-colors shrink-0 text-lg">
                  ↑
                </button>
              </div>
              <p className="text-[#c8b89a] text-xs mt-1.5">Enter to send · Shift+Enter for new line</p>
            </div>
          </>
        )}

        {/* ── Character chat tab ── */}
        {rightTab === "character" && (
          <>
            {/* Character picker */}
            <div className="shrink-0 px-4 py-3 border-b border-[#e8e0d5] bg-[#faf7f2]">
              {storyCharacters.length === 0 ? (
                <p className="text-xs text-[#a09282] text-center py-2">Loading characters…</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {storyCharacters.map((c, i) => {
                    const col = CHAR_COLORS[i % CHAR_COLORS.length];
                    const active = charChatCharacter?.name === c.name;
                    return (
                      <button key={`${i}-${c.name}`}
                        onClick={() => {
                          setCharChatCharacter(c);
                          setCharMessages([]);
                          setCharStreaming("");
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition-all border"
                        style={active
                          ? { background: col, color: "#fff", borderColor: col }
                          : { background: "white", color: "#6b5c4e", borderColor: "#e8e0d5" }
                        }
                      >
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: active ? "rgba(255,255,255,0.6)" : col }} />
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Chat area */}
            {!charChatCharacter ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
                <div className="w-14 h-14 rounded-full border-2 border-[#e8e0d5] flex items-center justify-center text-2xl text-[#c8b89a]">◉</div>
                <div>
                  <p className="text-sm font-semibold text-[#1c1410]">Choose a character</p>
                  <p className="text-xs text-[#a09282] mt-1 leading-relaxed max-w-xs">They'll speak from inside their story — with full memory of everything that happened to them.</p>
                </div>
              </div>
            ) : (
              <>
                {/* Character header */}
                <div className="shrink-0 px-4 py-3 flex items-center gap-3 bg-white border-b border-[#e8e0d5]">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0"
                    style={{ backgroundColor: CHAR_COLORS[storyCharacters.findIndex(c => c.name === charChatCharacter.name) % CHAR_COLORS.length] }}>
                    {charChatCharacter.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[#1c1410] text-sm">{charChatCharacter.name}</div>
                    <div className="text-xs text-[#a09282] truncate italic">
                      {charChatCharacter.role && <span className="capitalize">{charChatCharacter.role} · </span>}
                      speaking from inside {story.title}
                    </div>
                  </div>
                  <button onClick={() => { setCharMessages([]); setCharStreaming(""); }}
                    className="text-sm text-[#c8b89a] hover:text-[#a09282] transition-colors px-3 py-1.5 rounded-lg hover:bg-[#f7f3ed]">
                    clear
                  </button>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
                  {charMessages.length === 0 && !charStreaming && (
                    <div className="space-y-2 pt-2">
                      <p className="text-[#a09282] text-xs text-center mb-3">Ask {charChatCharacter.name} anything</p>
                      {[
                        `Why did you make the choices you did?`,
                        `What do you regret most?`,
                        `What do you think of ${storyCharacters.find(c => c.name !== charChatCharacter.name)?.name || "the others"}?`,
                        `What would you do differently?`,
                      ].map(q => (
                        <button key={q} onClick={() => setCharInput(q)}
                          className="w-full text-left text-sm text-[#6b5c4e] bg-[#f7f3ed] hover:bg-[#fef3e2] border border-[#e8e0d5] hover:border-[#f0c060]/50 px-4 py-3 rounded-xl transition-colors leading-relaxed">
                          {q}
                        </button>
                      ))}
                    </div>
                  )}

                  {charMessages.map((m, i) => {
                    const charIdx = storyCharacters.findIndex(c => c.name === charChatCharacter.name);
                    const col = CHAR_COLORS[charIdx % CHAR_COLORS.length];
                    return (
                      <div key={i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                        {m.role === "assistant" && (
                          <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 mt-0.5"
                            style={{ backgroundColor: col }}>
                            {charChatCharacter.name[0]}
                          </div>
                        )}
                        <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                          m.role === "user" ? "rounded-br-sm text-white" : "rounded-bl-sm bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5]"
                        }`} style={m.role === "user" ? { backgroundColor: col } : {}}>
                          {m.content}
                        </div>
                      </div>
                    );
                  })}

                  {/* Streaming */}
                  {(charLoading || charStreaming) && (() => {
                    const charIdx = storyCharacters.findIndex(c => c.name === charChatCharacter.name);
                    const col = CHAR_COLORS[charIdx % CHAR_COLORS.length];
                    return (
                      <div className="flex gap-2 justify-start">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 mt-0.5"
                          style={{ backgroundColor: col, boxShadow: `0 0 0 3px ${col}30` }}>
                          {charChatCharacter.name[0]}
                        </div>
                        <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-[#f7f3ed] border border-[#e8e0d5] text-sm leading-relaxed text-[#1c1410]">
                          {charStreaming ? (
                            <>{charStreaming}<span className="animate-pulse" style={{ color: col }}>▌</span></>
                          ) : (
                            <div className="flex gap-1.5 items-center h-4">
                              <div className="w-1.5 h-1.5 rounded-full animate-breathe" style={{ backgroundColor: col, animationDelay: "0ms" }} />
                              <div className="w-1.5 h-1.5 rounded-full animate-breathe" style={{ backgroundColor: col, animationDelay: "300ms" }} />
                              <div className="w-1.5 h-1.5 rounded-full animate-breathe" style={{ backgroundColor: col, animationDelay: "600ms" }} />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  <div ref={charChatEndRef} />
                </div>

                {/* Input */}
                <div className="p-4 border-t border-[#e8e0d5] shrink-0">
                  <div className="flex gap-2 items-end">
                    <textarea value={charInput} onChange={e => setCharInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCharMessage(); } }}
                      placeholder={`Ask ${charChatCharacter.name}…`} rows={2}
                      className="flex-1 resize-none bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-xl px-3.5 py-2.5 text-sm text-[#1c1410] placeholder-[#c8b89a] focus:outline-none leading-relaxed transition-colors" />
                    <button onClick={sendCharMessage} disabled={!charInput.trim() || charLoading}
                      className="w-10 h-10 rounded-xl disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white flex items-center justify-center transition-colors shrink-0 text-lg"
                      style={{ backgroundColor: !charInput.trim() || charLoading ? undefined : CHAR_COLORS[storyCharacters.findIndex(c => c.name === charChatCharacter.name) % CHAR_COLORS.length] }}>
                      ↑
                    </button>
                  </div>
                  <p className="text-[#c8b89a] text-xs mt-1.5">Enter to send · Shift+Enter for new line</p>
                </div>
              </>
            )}
          </>
        )}

      </div>

    </main>
  );
}

function DebateList({ debates, storyId, onDelete }: {
  debates: any[];
  storyId: string;
  onDelete: (id: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (debateId: string) => {
    setDeletingId(debateId);
    try {
      await fetch(`${API}/debates/${debateId}`, { method: "DELETE" });
      onDelete(debateId);
    } catch (e) { console.error("Failed to delete debate:", e); }
    setDeletingId(null);
    setConfirmId(null);
  };

  return (
    <div className="px-8 lg:px-14 pb-6 space-y-3">
      <div className="flex items-center gap-3">
        <div className="text-xs text-[#a09282] uppercase tracking-widest font-medium">Past Debates</div>
        <div className="flex-1 h-px bg-[#e8e0d5]" />
        <span className="text-xs text-[#a09282] bg-[#f0ebe4] border border-[#e8e0d5] px-2 py-0.5 rounded-full">{debates.length}</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {debates.map((d: any, i: number) => (
          <div key={d.id} className="group relative bg-white border border-[#e8e0d5] hover:border-[#c8b89a] hover:shadow-sm rounded-xl transition-all duration-200 overflow-hidden">
            {confirmId === d.id ? (
              /* Inline confirm overlay */
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <p className="text-sm text-[#1c1410]">Remove this debate?</p>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => handleDelete(d.id)}
                    disabled={deletingId === d.id}
                    className="text-xs px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium transition-colors disabled:opacity-60"
                  >
                    {deletingId === d.id ? "Removing…" : "Remove"}
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-[#e8e0d5] text-[#6b5c4e] hover:bg-[#f7f3ed] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <Link href={`/story/${storyId}/debate?replay=${d.id}`} className="block p-4">
                <div className="flex items-start gap-3">
                  <div className="text-[#c8b89a] text-sm font-mono mt-0.5 w-5 shrink-0">{String(i + 1).padStart(2, "0")}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[#6b5c4e] text-sm leading-relaxed group-hover:text-[#1c1410] transition-colors line-clamp-2">{d.divergence_description}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-[#a09282]">
                      <span>{d.round_count} rounds</span>
                      <span>·</span>
                      <span className="truncate">{(d.participating_characters || []).slice(0, 3).join(", ")}{(d.participating_characters || []).length > 3 ? "…" : ""}</span>
                      {d.created_at && (
                        <>
                          <span>·</span>
                          <span>{new Date(d.created_at + (d.created_at?.endsWith("Z") ? "" : "Z")).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Status badge → delete button on hover, same slot */}
                  <div className="shrink-0 relative flex justify-end items-start">
                    <span className={`group-hover:opacity-0 transition-opacity text-xs px-2.5 py-0.5 rounded-full border font-medium whitespace-nowrap ${
                      d.status === "completed"    ? "border-emerald-200 text-emerald-700 bg-emerald-50" :
                      d.status === "interrupted" || d.status === "running" ? "border-amber-200 text-amber-700 bg-amber-50" :
                      "border-[#e8e0d5] text-[#a09282] bg-[#f7f3ed]"
                    }`}>{
                      d.status === "completed"   ? "✓ done" :
                      d.status === "interrupted" || d.status === "running" ? "↯ ended" :
                      d.status
                    }</span>
                    <button
                      onClick={(e) => { e.preventDefault(); setConfirmId(d.id); }}
                      className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center w-7 h-7 ml-auto rounded-lg bg-[#f7f3ed] hover:bg-red-50 hover:text-red-500 text-[#a09282] text-sm border border-transparent hover:border-red-200"
                      title="Remove debate"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
