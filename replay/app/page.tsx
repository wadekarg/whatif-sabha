"use client";

import { useState } from "react";
import Link from "next/link";
import {
  story,
  debate,
  DEBATE_ID,
  listCast,
  listAllCharacters,
  capitalize,
  bundledDebateStats,
  CHAR_COLORS,
  type CharacterDossier,
  type StoryQA,
} from "./lib/data";

const ROLE_COLOR: Record<string, string> = {
  protagonist: "#c07820",
  antagonist: "#ef4444",
  supporting: "#3b82f6",
  minor: "#a09282",
  moderator: "#a855f7",
};

export default function StoryPage() {
  const [rightTab, setRightTab] = useState<"story" | "character">("story");
  const [storyOpenIdx, setStoryOpenIdx] = useState<number | null>(null);
  const [charChat, setCharChat] = useState<CharacterDossier | null>(null);

  const cast = listCast();
  const allChars = listAllCharacters();
  const pastDebateStats = bundledDebateStats();
  const divergenceText = capitalize(story.demo_divergence || debate?.story?.divergence || "");

  return (
    <main className="flex overflow-hidden bg-[#f7f3ed]" style={{ height: "calc(100vh - 56px)" }}>

      {/* ── Left: story content ── */}
      <div className="flex-1 overflow-y-auto">

        {/* HERO */}
        <div className="px-8 lg:px-14 pt-6 pb-0">
          <div className="bg-white rounded-2xl border border-[#e8e0d5] overflow-hidden">
            <div className="px-6 pt-6 pb-5 space-y-4">

              <h1 className="text-4xl lg:text-5xl font-bold tracking-tight leading-tight text-[#1c1410]">
                {story.title}
              </h1>

              <div className="flex flex-wrap items-center gap-3">
                {story.author && (
                  <span className="text-sm text-[#a09282]">
                    by <span className="text-[#6b5c4e] italic">{story.author}</span>
                  </span>
                )}
                {story.author && story.word_count ? <span className="text-[#d4c4a8]">·</span> : null}
                {story.word_count ? (
                  <span className="text-sm text-[#a09282]">
                    <span className="font-semibold text-[#6b5c4e]">{Math.round((story.word_count ?? 0) / 1000)}k</span> words
                  </span>
                ) : null}
                {(story.themes || []).length > 0 && <span className="text-[#d4c4a8]">·</span>}
                {(story.themes || []).map((t: string) => (
                  <span key={t} className="text-xs bg-[#fef3e2] border border-[#f0c060]/50 text-[#c07820] px-3 py-1 rounded-full font-medium">{t}</span>
                ))}
                <span className="ml-auto text-[10px] uppercase tracking-widest text-[#a09282] bg-[#f7f3ed] border border-[#e8e0d5] px-2.5 py-1 rounded-full font-semibold">Bundled demo</span>
              </div>

              {story.synopsis && <p className="text-[#6b5c4e] leading-relaxed text-sm">{story.synopsis}</p>}

              <div className="flex items-center gap-2">
                <Link href="/characters/" className="text-xs px-3 py-1.5 rounded-full border border-[#e8e0d5] bg-[#f7f3ed] text-[#6b5c4e] hover:border-[#c8b89a] hover:bg-white transition-colors font-medium">
                  🎭 {cast.length} Characters
                </Link>
                <Link href="/debate/" className="text-xs px-3 py-1.5 rounded-full border border-[#e8e0d5] bg-[#f7f3ed] text-[#6b5c4e] hover:border-[#c8b89a] hover:bg-white transition-colors font-medium">
                  ⚡ Sabha
                </Link>
              </div>
            </div>

            {/* Cast strip */}
            <div className="px-6 pb-5 border-t border-[#f0ece5]">
              <div className="flex items-center gap-2 py-3">
                <span className="text-xs text-[#a09282] uppercase tracking-widest font-medium">Cast</span>
                <div className="flex-1 h-px bg-[#f0ece5]" />
                <Link href="/characters/" className="text-xs text-[#c07820] hover:underline font-medium">See all →</Link>
              </div>
              <div className="flex gap-5 overflow-x-auto pb-1">
                {cast.slice(0, 14).map((char, i) => {
                  const col = CHAR_COLORS[i % CHAR_COLORS.length];
                  const initials = char.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
                  return (
                    <Link key={char.slug} href={`/characters/${char.slug}/`}
                      className="flex flex-col items-center gap-1.5 shrink-0 group">
                      {char.portrait_url ? (
                        <img src={char.portrait_url} alt={char.name}
                          className="w-12 h-12 rounded-full object-cover shadow-sm group-hover:scale-110 group-hover:shadow-md transition-all duration-200 ring-2 ring-white" />
                      ) : (
                        <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base shadow-sm group-hover:scale-110 group-hover:shadow-md transition-all duration-200 ring-2 ring-white"
                          style={{ backgroundColor: col }}>{initials}</div>
                      )}
                      <span className="text-xs font-semibold text-[#6b5c4e] group-hover:text-[#1c1410] transition-colors text-center leading-none">{char.name.split(" ")[0]}</span>
                      {char.role && (
                        <span className="text-[10px] font-medium capitalize" style={{ color: ROLE_COLOR[char.role] || "#a09282" }}>{char.role}</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* WHAT IF — read-only for the demo */}
        <div className="px-8 lg:px-14 py-6">
          <div className="bg-white rounded-2xl border-2 border-[#e8e0d5] overflow-hidden">
            <div className="px-6 pt-5 pb-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">⚡</span>
                <span className="text-sm font-bold text-[#1c1410]">What if…</span>
                <span className="text-xs text-[#a09282]">— this demo's divergence</span>
                <span className="ml-auto text-[10px] uppercase tracking-widest text-[#a09282] bg-[#f7f3ed] border border-[#e8e0d5] px-2 py-0.5 rounded-full font-semibold">Pre-bundled</span>
              </div>
              <p className="text-[#1c1410] text-sm leading-relaxed">{divergenceText}</p>
            </div>
            <div className="px-6 py-3 bg-[#faf7f2] border-t border-[#e8e0d5] flex items-center justify-between">
              <span className="text-xs text-[#a09282]">In the full app you write your own "what if" — here the divergence is baked in.</span>
              <Link href="/debate/"
                className="flex items-center gap-1.5 text-sm font-bold px-5 py-2 rounded-xl bg-[#c07820] hover:bg-[#a86a18] text-white shadow-sm transition-colors">
                <span>⚡</span> Watch the Sabha
              </Link>
            </div>
          </div>
        </div>

        {/* STORY INTELLIGENCE — timeline */}
        <div className="px-8 lg:px-14 pb-10 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">✦</div>
            <div className="text-sm font-semibold text-[#1c1410]">Story timeline</div>
            <div className="flex-1 h-px bg-[#e8e0d5]" />
            <span className="text-xs text-[#a09282]">{story.timeline.length} moments</span>
          </div>

          <div className="relative">
            <div className="absolute left-[11px] top-0 bottom-0 w-0.5 bg-gradient-to-b from-[#c07820] via-[#c8b89a]/40 to-[#e8e0d5]" />
            <div className="space-y-2">
              {story.timeline.map((t, i) => {
                const isFirst = i === 0;
                const isLast  = i === story.timeline.length - 1;
                return (
                  <div key={i} className="flex gap-4 pl-0">
                    <div className={`w-6 h-6 rounded-full shrink-0 mt-0.5 z-10 flex items-center justify-center text-xs font-bold border-2 ${
                      isFirst ? "bg-[#fef3e2] border-[#c07820] text-[#c07820]" :
                      isLast  ? "bg-red-50 border-red-400 text-red-500" :
                      "bg-white border-[#c8b89a] text-[#a09282]"
                    }`}>
                      {isFirst ? "▶" : isLast ? "✕" : "·"}
                    </div>
                    <div className={`flex-1 rounded-xl p-4 border ${
                      isFirst ? "bg-[#fef9f0] border-[#f0c060]/50" :
                      isLast  ? "bg-red-50/50 border-red-200" :
                      "bg-white border-[#e8e0d5]"
                    }`}>
                      <div className="text-xs uppercase tracking-widest font-semibold text-[#a09282] mb-1">{t.era}</div>
                      <p className="text-sm text-[#1c1410] leading-relaxed">{t.event}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* PAST DEBATES — the one bundled */}
        <div className="px-8 lg:px-14 pb-10 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">⚡</div>
            <div className="text-sm font-semibold text-[#1c1410]">Past debates</div>
            <div className="flex-1 h-px bg-[#e8e0d5]" />
            <span className="text-xs text-[#a09282]">1 bundled</span>
          </div>

          <Link href="/debate/" className="block bg-white border border-[#e8e0d5] hover:border-[#c07820]/40 rounded-2xl p-5 transition-colors group">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-[#fef3e2] border border-[#f0c060]/50 flex items-center justify-center text-lg shrink-0">⚡</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-semibold capitalize">{pastDebateStats.status}</span>
                  {pastDebateStats.date && <span className="text-xs text-[#a09282]">{pastDebateStats.date}</span>}
                </div>
                <p className="text-sm font-semibold text-[#1c1410] leading-snug group-hover:text-[#c07820] transition-colors">{capitalize(pastDebateStats.topic)}</p>
                <div className="flex items-center gap-3 mt-2 text-xs text-[#a09282]">
                  <span><span className="font-semibold text-[#6b5c4e]">{pastDebateStats.turns}</span> turns</span>
                  <span>·</span>
                  <span><span className="font-semibold text-[#6b5c4e]">{pastDebateStats.speakers}</span> speakers</span>
                </div>
              </div>
              <span className="text-[#c8b89a] group-hover:text-[#c07820] transition-colors shrink-0">→</span>
            </div>
          </Link>
        </div>

        {/* ── Footer (matches live app) ── */}
        <footer className="bg-[#faf7f2] border-t border-[#e8e0d5] py-3 px-6 mt-auto">
          <div className="text-center text-[11px] italic text-[#c8b89a] mb-2">
            What if things had gone differently?
          </div>
          <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-[#a09282]">
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-md bg-[#c07820] flex items-center justify-center" style={{ fontSize: "14px", lineHeight: 1, color: "#fef9c3" }}>☸</span>
              <span className="font-semibold text-[#1c1410]">WhatIf<span className="text-[#c07820]">Sabha</span></span>
            </span>
            <span className="text-[#e8e0d5]">·</span>
            <a href="https://github.com/wadekarg/whatif-sabha" target="_blank" rel="noopener noreferrer" className="hover:text-[#c07820] transition-colors">GitHub</a>
            <span className="text-[#e8e0d5]">·</span>
            <a href="https://github.com/wadekarg" target="_blank" rel="noopener noreferrer" className="hover:text-[#c07820] transition-colors">@wadekarg</a>
            <span className="text-[#e8e0d5]">·</span>
            <a href="https://www.linkedin.com/in/gajananwadekar/" target="_blank" rel="noopener noreferrer" className="hover:text-[#c07820] transition-colors">LinkedIn</a>
            <span className="text-[#e8e0d5]">·</span>
            <span>MIT</span>
          </div>
        </footer>

      </div>

      {/* ── Right: tabbed Q&A panel ── */}
      <div className="w-[460px] shrink-0 border-l border-[#e8e0d5] bg-white flex flex-col">

        <div className="shrink-0 border-b border-[#e8e0d5] flex">
          <button onClick={() => setRightTab("story")}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-sm font-semibold transition-colors border-b-2 ${
              rightTab === "story" ? "text-[#c07820] border-[#c07820]" : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
            }`}>
            <span>✦</span> Ask the Story
          </button>
          <button onClick={() => setRightTab("character")}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-sm font-semibold transition-colors border-b-2 ${
              rightTab === "character" ? "text-[#c07820] border-[#c07820]" : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
            }`}>
            <span>◉</span> Talk to Characters
          </button>
        </div>

        {/* Pre-recorded samples badge */}
        <div className="shrink-0 px-4 py-2 bg-[#fef3e2]/50 border-b border-[#f0c060]/30 text-center">
          <span className="text-[11px] uppercase tracking-widest text-[#c07820] font-semibold">🎤 Pre-recorded samples</span>
        </div>

        {/* ── Story Q&A tab ── */}
        {rightTab === "story" && (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {story.qa.length === 0 ? (
                <p className="text-center text-[#a09282] text-sm italic mt-8">No sample questions yet.</p>
              ) : story.qa.map((qa, i) => (
                <QABubbles key={i} qa={qa} speakerColor="#c07820" speakerLabel="Boru" speakerInitial="✦" isOpen={storyOpenIdx === i} onToggle={() => setStoryOpenIdx(storyOpenIdx === i ? null : i)} />
              ))}
            </div>
            <DisabledInput placeholder="Ask about characters, plot, themes…" />
          </>
        )}

        {/* ── Character Q&A tab ── */}
        {rightTab === "character" && (
          <>
            <div className="shrink-0 px-4 py-3 border-b border-[#e8e0d5] bg-[#faf7f2]">
              <div className="flex flex-wrap gap-1.5">
                {allChars.map((c, i) => {
                  const col = CHAR_COLORS[i % CHAR_COLORS.length];
                  const active = charChat?.slug === c.slug;
                  return (
                    <button key={c.slug} onClick={() => setCharChat(c)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition-all border"
                      style={active ? { background: col, color: "#fff", borderColor: col } : { background: "white", color: "#6b5c4e", borderColor: "#e8e0d5" }}>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: active ? "rgba(255,255,255,0.6)" : col }} />
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {!charChat ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
                <div className="w-14 h-14 rounded-full border-2 border-[#e8e0d5] flex items-center justify-center text-2xl text-[#c8b89a]">◉</div>
                <div>
                  <p className="text-sm font-semibold text-[#1c1410]">Choose a character</p>
                  <p className="text-xs text-[#a09282] mt-1 leading-relaxed max-w-xs">Read their pre-recorded samples. In the full app they respond live.</p>
                </div>
              </div>
            ) : (
              <CharacterChatPane char={charChat} />
            )}

            <DisabledInput placeholder={charChat ? `Ask ${charChat.name}…` : "Pick a character…"} />
          </>
        )}

      </div>
    </main>
  );
}

/* ──────────────── Sub-components ──────────────── */

function QABubbles({
  qa, speakerColor, speakerLabel, speakerInitial, isOpen, onToggle,
}: {
  qa: StoryQA;
  speakerColor: string;
  speakerLabel: string;
  speakerInitial: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="space-y-2">
      {/* User bubble — always visible, clickable to expand/collapse */}
      <button onClick={onToggle} className="flex justify-end w-full group">
        <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-br-sm text-sm leading-relaxed bg-[#c07820] text-white text-left">
          {qa.question}
          <span className="opacity-60 ml-2 text-xs">{isOpen ? "▾" : "▸"}</span>
        </div>
      </button>

      {/* Assistant bubble — collapsed by default */}
      {isOpen && (
        <div className="flex justify-start">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 mr-2 mt-0.5 bg-[#fef3e2] border border-[#f0c060]" style={{ color: speakerColor }}>
            {speakerInitial}
          </div>
          <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] whitespace-pre-wrap">
            {qa.answer}
          </div>
        </div>
      )}
    </div>
  );
}

function CharacterChatPane({ char }: { char: CharacterDossier }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  const allChars = listAllCharacters();
  const charIdx = allChars.findIndex(c => c.slug === char.slug);
  const col = CHAR_COLORS[charIdx % CHAR_COLORS.length];
  const initials = char.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <>
      {/* Character header */}
      <div className="shrink-0 px-4 py-3 flex items-center gap-3 bg-white border-b border-[#e8e0d5]">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0" style={{ backgroundColor: col }}>{initials}</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[#1c1410] text-sm">{char.name}</div>
          <div className="text-xs text-[#a09282] truncate italic">
            {char.role && <span className="capitalize">{char.role} · </span>}
            speaking from inside {story.title}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {char.qa.length === 0 ? (
          <p className="text-center text-[#a09282] text-sm italic mt-8 px-6 leading-relaxed">
            No pre-recorded samples for {char.name} yet. In the full app you could ask them anything live.
          </p>
        ) : char.qa.map((qa, i) => (
          <div key={i} className="space-y-2">
            <button onClick={() => setOpenIdx(openIdx === i ? null : i)} className="flex justify-end w-full">
              <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-br-sm text-sm leading-relaxed text-white text-left" style={{ backgroundColor: col }}>
                {qa.question}
                <span className="opacity-60 ml-2 text-xs">{openIdx === i ? "▾" : "▸"}</span>
              </div>
            </button>
            {openIdx === i && (
              <div className="flex gap-2 justify-start">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 mt-0.5" style={{ backgroundColor: col }}>
                  {char.name[0]}
                </div>
                <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] text-sm leading-relaxed whitespace-pre-wrap">
                  {qa.answer}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function DisabledInput({ placeholder }: { placeholder: string }) {
  return (
    <div className="p-4 border-t border-[#e8e0d5] shrink-0 relative">
      <div className="flex gap-2 items-end opacity-55 pointer-events-none select-none">
        <div className="flex-1 resize-none bg-[#f7f3ed] border border-[#e8e0d5] rounded-xl px-3.5 py-2.5 text-sm text-[#a09282] leading-relaxed min-h-[3rem] flex items-center">
          🔒 {placeholder}
        </div>
        <div className="w-10 h-10 rounded-xl bg-[#e8e0d5] text-[#c8b89a] flex items-center justify-center text-lg shrink-0">↑</div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-[#a09282] flex-1 leading-snug">
          Live chat is backend-powered.
        </span>
        <a href="https://github.com/wadekarg/whatif-sabha#-quick-start" target="_blank" rel="noopener"
          className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#c07820] text-white hover:bg-[#a86a18] transition-colors whitespace-nowrap">
          Run the app ↗
        </a>
      </div>
    </div>
  );
}
