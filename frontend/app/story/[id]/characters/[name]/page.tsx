"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8001";

const ROLE_STYLE: Record<string, { text: string; bg: string; border: string; avatar: string }> = {
  protagonist: { text: "text-[#c07820]",  bg: "bg-[#fef3e2]", border: "border-[#f0c060]",  avatar: "bg-[#fef3e2] text-[#c07820] border-[#f0c060]"  },
  antagonist:  { text: "text-red-600",    bg: "bg-red-50",    border: "border-red-200",     avatar: "bg-red-50 text-red-700 border-red-200"           },
  supporting:  { text: "text-blue-600",   bg: "bg-blue-50",   border: "border-blue-200",    avatar: "bg-blue-50 text-blue-700 border-blue-200"        },
  neutral:     { text: "text-[#6b5c4e]",  bg: "bg-[#f7f3ed]", border: "border-[#e8e0d5]",  avatar: "bg-[#f0ebe4] text-[#6b5c4e] border-[#e8e0d5]"   },
};

export default function CharacterDetailPage() {
  const { id, name } = useParams<{ id: string; name: string }>();
  const [character, setCharacter] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activePhase, setActivePhase] = useState(0);
  const [showFairWitness, setShowFairWitness] = useState(false);

  useEffect(() => {
    fetch(`${API}/stories/${id}/characters/${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((data) => { setCharacter(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id, name]);

  if (loading) return (
    <main className="flex-1 flex items-center justify-center bg-[#f7f3ed]">
      <div className="text-[#a09282] animate-breathe text-lg">Loading...</div>
    </main>
  );

  if (!character) return (
    <main className="flex-1 flex items-center justify-center bg-[#f7f3ed]">
      <div className="text-red-500">Character not found.</div>
    </main>
  );

  const fw = character.fair_witness;
  const phases: any[] = character.phases || [];
  const phase = phases[activePhase];
  const rs = ROLE_STYLE[character.role] || ROLE_STYLE.neutral;

  return (
    <main className="flex-1 bg-[#f7f3ed]">
      {/* Hero */}
      <div className="bg-white border-b border-[#e8e0d5]">
        <div className="max-w-4xl mx-auto px-8 py-8">
          <Link
            href={`/story/${id}/characters`}
            className="inline-flex items-center gap-1 text-[#a09282] hover:text-[#1c1410] text-sm transition-colors mb-6"
          >
            ← Characters
          </Link>
          <div className="flex items-start gap-5">
            {/* Avatar */}
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold shrink-0 border-2 ${rs.avatar}`}>
              {character.name[0]}
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-3xl font-bold text-[#1c1410]">{character.name}</h1>
                <span className={`text-xs uppercase tracking-widest px-2.5 py-1 rounded-full border font-semibold ${rs.text} ${rs.border} ${rs.bg}`}>
                  {character.role}
                </span>
                {fw && (
                  <span className="text-xs bg-[#fef3e2] text-[#c07820] border border-[#f0c060] px-2.5 py-1 rounded-full font-medium">
                    ✦ Fair Witness
                  </span>
                )}
              </div>
              <p className="text-[#6b5c4e] leading-relaxed max-w-2xl">{character.description}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
        {/* Fair Witness Panel */}
        {fw && (
          <div className={`border rounded-2xl overflow-hidden bg-white transition-all ${showFairWitness ? "border-[#f0c060]" : "border-[#e8e0d5]"}`}>
            <button
              onClick={() => setShowFairWitness(!showFairWitness)}
              className={`w-full flex items-center justify-between px-6 py-4 transition-colors text-left ${
                showFairWitness ? "bg-[#fef3e2]" : "bg-white hover:bg-[#faf7f2]"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-[#c07820] text-sm">
                  ✦
                </div>
                <div>
                  <div className="font-semibold text-[#c07820] text-sm">Fair Witness Analysis</div>
                  <div className="text-xs text-[#a09282] mt-0.5">Wikipedia · web sources · 3 independent AI perspectives</div>
                </div>
              </div>
              <div className={`text-[#a09282] text-xs transition-transform duration-200 ${showFairWitness ? "rotate-180" : ""}`}>▼</div>
            </button>

            {showFairWitness && (
              <div className="px-6 py-5 space-y-5 border-t border-[#f0c060]/30 animate-fade-up">
                {fw.fair_role && (
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest w-28 shrink-0 pt-0.5 font-medium">Fair Role</div>
                    <div className="text-[#c07820] font-semibold">{fw.fair_role}</div>
                  </div>
                )}

                {fw.consensus_view && (
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest w-28 shrink-0 pt-0.5 font-medium">True Self</div>
                    <p className="text-[#6b5c4e] leading-relaxed text-sm flex-1">{fw.consensus_view}</p>
                  </div>
                )}

                {fw.narrative_bias && (
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest w-28 shrink-0 pt-0.5 font-medium">Narrative Bias</div>
                    <p className="text-[#6b5c4e] text-sm leading-relaxed italic border-l-2 border-red-300 pl-3 flex-1">{fw.narrative_bias}</p>
                  </div>
                )}

                {fw.hidden_motivations && (
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest w-28 shrink-0 pt-0.5 font-medium">Hidden</div>
                    <p className="text-[#6b5c4e] text-sm leading-relaxed flex-1">{fw.hidden_motivations}</p>
                  </div>
                )}

                {fw.what_they_would_say && (
                  <div className="bg-[#fef3e2] rounded-xl p-5 border border-[#f0c060]/50 relative overflow-hidden">
                    <div className="absolute top-3 left-5 text-4xl text-[#f0c060] font-serif leading-none select-none">"</div>
                    <div className="text-xs text-[#a09282] uppercase tracking-widest mb-3 font-medium">In Their Own Words</div>
                    <p className="text-[#6b5c4e] italic leading-relaxed">"{fw.what_they_would_say}"</p>
                  </div>
                )}

                {fw.fair_personality_traits?.length > 0 && (
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest w-28 shrink-0 pt-1.5 font-medium">Traits</div>
                    <div className="flex flex-wrap gap-2 flex-1">
                      {fw.fair_personality_traits.map((t: string) => (
                        <span key={t} className="text-xs bg-white text-[#6b5c4e] px-3 py-1 rounded-full border border-[#e8e0d5]">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {fw.disputed_aspects?.length > 0 && (
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest w-28 shrink-0 pt-0.5 font-medium">Disputed</div>
                    <ul className="space-y-1.5 flex-1">
                      {fw.disputed_aspects.map((a: any, i: number) => (
                        <li key={i} className="text-sm text-[#6b5c4e] flex gap-2">
                          <span className="text-[#c8b89a] mt-1">◦</span>
                          {typeof a === "string" ? a : JSON.stringify(a)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Character Arc */}
        {phases.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-[#a09282] uppercase tracking-widest">Character Arc</h2>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {phases.map((p: any, i: number) => (
                <button
                  key={i}
                  onClick={() => setActivePhase(i)}
                  className={`flex-shrink-0 px-4 py-2 rounded-xl text-xs font-medium transition-all duration-200 ${
                    i === activePhase
                      ? "bg-[#c07820] text-white shadow-sm"
                      : "bg-white text-[#6b5c4e] hover:bg-[#faf7f2] hover:text-[#1c1410] border border-[#e8e0d5]"
                  }`}
                >
                  {p.phase_id || `Phase ${i + 1}`}
                </button>
              ))}
            </div>

            {phase && (
              <div className="bg-white rounded-2xl border border-[#e8e0d5] overflow-hidden animate-fade-up">
                {phase.emotional_state && (
                  <div className="px-6 py-4 border-b border-[#e8e0d5] flex items-center gap-3 bg-[#faf7f2]">
                    <span className="text-xs text-[#a09282] uppercase tracking-widest w-32 shrink-0 font-medium">Emotional State</span>
                    <span className="text-[#1c1410] text-sm font-medium">{phase.emotional_state}</span>
                  </div>
                )}

                <div className="p-6 grid sm:grid-cols-2 gap-6">
                  {phase.personality_traits?.length > 0 && (
                    <div>
                      <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-medium">Traits</div>
                      <div className="flex flex-wrap gap-1.5">
                        {phase.personality_traits.map((t: string) => (
                          <span key={t} className="text-xs bg-[#f7f3ed] text-[#6b5c4e] px-2.5 py-1 rounded-full border border-[#e8e0d5]">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {phase.motivations?.length > 0 && (
                    <div>
                      <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-medium">Motivations</div>
                      <ul className="space-y-1">
                        {phase.motivations.map((m: any, i: number) => (
                          <li key={i} className="text-sm text-[#6b5c4e] flex gap-2">
                            <span className="text-[#c07820] mt-0.5">›</span>
                            {typeof m === "string" ? m : JSON.stringify(m)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {phase.knowledge_state && (
                  <div className="px-6 pb-6">
                    <div className="text-xs text-[#a09282] uppercase tracking-widest mb-3 font-medium">Knowledge</div>
                    {typeof phase.knowledge_state === "string" ? (
                      <p className="text-sm text-[#6b5c4e]">{phase.knowledge_state}</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {Object.entries(phase.knowledge_state).map(([key, val]) => (
                          <div key={key} className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                            val ? "bg-emerald-50 border border-emerald-200" : "bg-[#f7f3ed] border border-[#e8e0d5]"
                          }`}>
                            <span className={val ? "text-emerald-600" : "text-[#c8b89a]"}>{val ? "✓" : "✗"}</span>
                            <span className={val ? "text-[#1c1410]" : "text-[#a09282]"}>{key.replace(/_/g, " ")}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Key Revelations */}
        {character.knowledge_events?.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold text-[#a09282] uppercase tracking-widest">Key Revelations</h2>
            <div className="relative">
              <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[#e8e0d5]" />
              <div className="space-y-3">
                {character.knowledge_events.map((e: any, i: number) => (
                  <div key={i} className="flex gap-4 pl-1">
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-[#c07820] bg-[#f7f3ed] shrink-0 mt-1 z-10" />
                    <div className="bg-white border border-[#e8e0d5] rounded-xl p-4 flex-1">
                      <div className="font-medium text-sm text-[#1c1410]">{e.event}</div>
                      {e.impact && <div className="text-[#a09282] text-xs mt-1 leading-relaxed">{e.impact}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
