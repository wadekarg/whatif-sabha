"use client";

import { useState } from "react";
import type { CharacterDossier } from "../../lib/data";

const ROLE_COLOR: Record<string, string> = {
  protagonist: "#c07820",
  antagonist:  "#ef4444",
  supporting:  "#3b82f6",
  minor:       "#a09282",
  moderator:   "#a855f7",
};

function diffPhases(prev: any, next: any) {
  const added   = (next.personality_traits || []).filter((t: string) => !(prev.personality_traits || []).includes(t));
  const removed = (prev.personality_traits || []).filter((t: string) => !(next.personality_traits || []).includes(t));
  const prevKnow = prev.knowledge_state || {};
  const nextKnow = next.knowledge_state || {};
  const newKnowledge = Object.entries(nextKnow)
    .filter(([k, v]) => v && !prevKnow[k])
    .map(([k]) => k.replace(/_/g, " "));
  const prevMotiv = new Set(prev.motivations || []);
  const nextMotiv = new Set(next.motivations || []);
  const newMotivations = [...nextMotiv].filter(m => !prevMotiv.has(m));
  const lostMotivations = [...prevMotiv].filter(m => !nextMotiv.has(m));
  return { added, removed, newKnowledge, newMotivations, lostMotivations };
}

export default function CharacterArcView({ character }: { character: CharacterDossier }) {
  const charPhases: any[] = (character as any).phases || [];
  const tlPhases: any[] = (character as any).timeline_phases || [];
  const knowledgeEvents: any[] = (character as any).knowledge_events || [];
  const tlMeta: any = (character as any).timeline_metadata;
  const color = ROLE_COLOR[character.role] || "#6b5c4e";

  const [expandedPhases, setExpandedPhases] = useState<Set<number>>(new Set([0]));
  const togglePhase = (i: number) => setExpandedPhases(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  // Convert 0..1 position to story-native unit (e.g. "Farm Year 5.5")
  const toUnit = (pos: number | null): string => {
    if (pos == null) return "?";
    if (!tlMeta) return `${Math.round(pos * 100)}%`;
    const val = pos * tlMeta.total_duration;
    const startOffset = parseFloat((tlMeta.start_label || "").replace(/[^0-9.]/g, "") || "0") || 0;
    const adjusted = val + startOffset;
    const rounded = Math.round(adjusted * 10) / 10;
    return `${tlMeta.unit_name} ${rounded % 1 === 0 ? rounded.toFixed(0) : rounded}`;
  };

  // Merge character phases with timeline positions
  const phasesWithPos = charPhases.map((cp: any) => {
    const tl = tlPhases.find(t => t.phase_id === cp.phase_id) || {};
    return {
      ...cp,
      tl_start: tl.timeline_position_start ?? null,
      tl_end:   tl.timeline_position_end   ?? null,
      tl_name:  tl.name || cp.phase_id,
      tl_trigger: tl.trigger_event || "",
      chapter_range: tl.chapter_range || [],
    };
  });

  const sortedPhases = [...phasesWithPos].sort((a, b) => (a.tl_start ?? 0) - (b.tl_start ?? 0));
  const sortedKE = [...knowledgeEvents].sort((a, b) => (a.timeline_position ?? 0) - (b.timeline_position ?? 0));

  if (sortedPhases.length === 0 && tlPhases.length === 0) return null;

  return (
    <div className="space-y-8">
      {/* ── Story Timeline Bar ── */}
      {tlPhases.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest flex items-baseline gap-2">
            Story timeline
            {tlMeta && <span className="normal-case tracking-normal font-normal text-[#c07820]">{tlMeta.description}</span>}
          </div>
          <div className="relative h-8 bg-[#e8e0d5] rounded-full overflow-hidden">
            {tlPhases.map((tl, i) => {
              const start = (tl.timeline_position_start ?? 0) * 100;
              const width = ((tl.timeline_position_end ?? 1) - (tl.timeline_position_start ?? 0)) * 100;
              const hue = (i / tlPhases.length) * 240;
              return (
                <div key={i} title={tl.name}
                  className="absolute h-full flex items-center justify-center text-xs font-medium text-white/80 overflow-hidden"
                  style={{ left: `${start}%`, width: `${width}%`, backgroundColor: `hsl(${hue},50%,45%)`, borderRight: "1px solid rgba(255,255,255,0.3)" }}>
                  <span className="truncate px-1">{tl.name}</span>
                </div>
              );
            })}
            {sortedKE.map((ke, i) => ke.timeline_position != null && (
              <div key={i} title={ke.learns}
                className="absolute top-0 bottom-0 w-0.5 bg-[#c07820]/70 z-10"
                style={{ left: `${ke.timeline_position * 100}%` }} />
            ))}
          </div>
          <div className="flex justify-between text-xs text-[#a09282]">
            <span>{toUnit(0)}</span>
            {sortedKE.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-[#c07820]/70 inline-block" /> = knowledge gained
              </span>
            )}
            <span>{toUnit(1)}</span>
          </div>
        </div>
      )}

      {/* ── Character arc ── */}
      {sortedPhases.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest">Character arc</div>

          <div className="relative">
            {/* Vertical connector */}
            <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-[#e8e0d5]" />

            <div className="space-y-0">
              {sortedPhases.map((phase, pi) => {
                const isOpen = expandedPhases.has(pi);
                const diff = pi > 0 ? diffPhases(sortedPhases[pi-1], phase) : null;
                const hasDiff = diff && (diff.added.length || diff.removed.length || diff.newKnowledge.length || diff.newMotivations.length || diff.lostMotivations.length);
                const phaseKE = sortedKE.filter(ke => {
                  if (phase.tl_start == null) return false;
                  const pos = ke.timeline_position ?? 0;
                  return pos >= (phase.tl_start ?? 0) && pos < (phase.tl_end ?? 1);
                });

                return (
                  <div key={pi} className="relative">
                    {/* What changed since last phase */}
                    {hasDiff && (
                      <div className="ml-12 mb-2 mt-1 bg-[#fef9f0] border border-[#f0c060]/40 rounded-xl px-4 py-2.5 space-y-1">
                        <div className="text-xs text-[#c07820] font-semibold uppercase tracking-widest mb-1">↕ What changed</div>
                        {(diff!.added as string[]).map((t) => <div key={t} className="text-xs text-emerald-700 flex gap-1.5 items-center"><span className="text-emerald-500 font-bold">+</span> trait: {t}</div>)}
                        {(diff!.removed as string[]).map((t) => <div key={t} className="text-xs text-red-500 flex gap-1.5 items-center"><span className="font-bold">−</span> trait: {t}</div>)}
                        {(diff!.newKnowledge as string[]).map((k) => <div key={k} className="text-xs text-blue-700 flex gap-1.5 items-center"><span className="text-blue-500 font-bold">↗</span> learned: {k}</div>)}
                        {(diff!.newMotivations as string[]).map((m) => <div key={m as string} className="text-xs text-purple-700 flex gap-1.5 items-center"><span className="font-bold">→</span> new drive: {m as string}</div>)}
                        {(diff!.lostMotivations as string[]).map((m) => <div key={m as string} className="text-xs text-[#a09282] flex gap-1.5 items-center"><span className="font-bold">↓</span> lost drive: {m as string}</div>)}
                      </div>
                    )}

                    {/* Phase card */}
                    <div className="flex gap-3 items-start">
                      <div className="w-10 h-10 rounded-full shrink-0 border-2 flex items-center justify-center font-bold text-xs z-10 bg-white" style={{ borderColor: color, color }}>
                        {pi + 1}
                      </div>

                      <div className="flex-1 min-w-0 pb-4">
                        <button onClick={() => togglePhase(pi)}
                          className="w-full text-left bg-white border border-[#e8e0d5] rounded-2xl overflow-hidden hover:border-[#c8b89a] transition-colors">
                          <div className="px-5 py-4 flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-sm text-[#1c1410]">{phase.tl_name}</span>
                                {phase.tl_start != null && (
                                  <span className="text-xs text-[#a09282] bg-[#f0ebe4] px-2 py-0.5 rounded-full">
                                    {toUnit(phase.tl_start)} → {toUnit(phase.tl_end)}
                                  </span>
                                )}
                                {phase.chapter_range?.length === 2 && (
                                  <span className="text-xs text-[#a09282]">ch. {phase.chapter_range[0]}–{phase.chapter_range[1]}</span>
                                )}
                              </div>
                              {phase.emotional_state && (
                                <div className="text-xs text-[#6b5c4e] mt-1 italic">{phase.emotional_state}</div>
                              )}
                              {!isOpen && phase.personality_traits?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {phase.personality_traits.slice(0, 4).map((t: string) => (
                                    <span key={t} className="text-xs bg-[#f7f3ed] text-[#6b5c4e] px-2 py-0.5 rounded-full border border-[#e8e0d5]">{t}</span>
                                  ))}
                                  {phase.personality_traits.length > 4 && <span className="text-xs text-[#a09282]">+{phase.personality_traits.length - 4}</span>}
                                </div>
                              )}
                            </div>
                            <div className={`text-[#a09282] text-xs shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}>▼</div>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="mt-2 bg-white border border-[#e8e0d5] rounded-2xl overflow-hidden space-y-0">
                            {phase.tl_trigger && (
                              <div className="px-5 py-3 bg-[#fef9f0] border-b border-[#f0c060]/30">
                                <span className="text-xs text-[#c07820] uppercase tracking-widest font-semibold">What triggered this phase · </span>
                                <span className="text-xs text-[#6b5c4e]">{phase.tl_trigger}</span>
                              </div>
                            )}

                            <div className="p-5 grid sm:grid-cols-2 gap-6">
                              {/* Traits */}
                              {phase.personality_traits?.length > 0 && (
                                <div>
                                  <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-semibold">Personality</div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {phase.personality_traits.map((t: string, ti: number) => {
                                      const isNew = pi > 0 && !(sortedPhases[pi-1].personality_traits || []).includes(t);
                                      return (
                                        <span key={ti} className={`text-xs px-2.5 py-1 rounded-full border ${isNew ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-[#f7f3ed] border-[#e8e0d5] text-[#6b5c4e]"}`}>
                                          {isNew && <span className="mr-1 text-emerald-500">+</span>}{t}
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}

                              {/* Motivations */}
                              {phase.motivations?.length > 0 && (
                                <div>
                                  <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-semibold">Drives</div>
                                  <ul className="space-y-1.5">
                                    {phase.motivations.map((m: any, mi: number) => {
                                      const s = typeof m === "string" ? m : JSON.stringify(m);
                                      const isNew = pi > 0 && !(sortedPhases[pi-1].motivations || []).includes(s);
                                      return (
                                        <li key={mi} className="text-xs text-[#6b5c4e] flex gap-2 items-start">
                                          <span style={{ color }} className="mt-0.5 shrink-0">{isNew ? "↗" : "›"}</span>
                                          <span className={isNew ? "text-[#1c1410] font-medium" : ""}>{s}</span>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}

                              {/* Fears */}
                              {phase.fears?.length > 0 && (
                                <div>
                                  <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-semibold">Fears</div>
                                  <ul className="space-y-1.5">
                                    {phase.fears.map((f: any, fi: number) => (
                                      <li key={fi} className="text-xs text-[#6b5c4e] flex gap-2">
                                        <span className="text-red-400 mt-0.5 shrink-0">◦</span>
                                        {typeof f === "string" ? f : JSON.stringify(f)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Relationships */}
                              {phase.relationships && Object.keys(phase.relationships).length > 0 && (
                                <div>
                                  <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-semibold">Relationships</div>
                                  <div className="space-y-1.5">
                                    {Object.entries(phase.relationships).map(([rname, rel]: [string, any]) => {
                                      const trust = Math.round((rel.trust ?? 0.5) * 100);
                                      const prevRel = pi > 0 ? (sortedPhases[pi-1].relationships || {})[rname] : null;
                                      const trustDelta = prevRel ? trust - Math.round((prevRel.trust ?? 0.5) * 100) : 0;
                                      return (
                                        <div key={rname} className="flex items-center gap-2">
                                          <span className="text-xs font-medium text-[#1c1410] w-20 truncate shrink-0">{rname}</span>
                                          <div className="flex-1 h-1.5 bg-[#e8e0d5] rounded-full overflow-hidden">
                                            <div className="h-full rounded-full transition-all" style={{ width: `${trust}%`, backgroundColor: trust > 60 ? "#10b981" : trust > 30 ? "#f59e0b" : "#ef4444" }} />
                                          </div>
                                          <span className="text-xs text-[#a09282] w-8 text-right shrink-0">{trust}%</span>
                                          {trustDelta !== 0 && (
                                            <span className={`text-xs font-medium shrink-0 ${trustDelta > 0 ? "text-emerald-600" : "text-red-500"}`}>
                                              {trustDelta > 0 ? "+" : ""}{trustDelta}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Knowledge state */}
                            {phase.knowledge_state && Object.keys(phase.knowledge_state).length > 0 && (
                              <div className="px-5 pb-5">
                                <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-semibold">What they know</div>
                                <div className="grid grid-cols-2 gap-1.5">
                                  {Object.entries(phase.knowledge_state).map(([k, v]) => {
                                    const prevKnow = pi > 0 ? (sortedPhases[pi-1].knowledge_state || {})[k] : undefined;
                                    const isNewlyLearned = v && !prevKnow;
                                    return (
                                      <div key={k} className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${
                                        isNewlyLearned ? "bg-blue-50 border border-blue-200" :
                                        v ? "bg-emerald-50 border border-emerald-100" : "bg-[#f7f3ed] border border-[#e8e0d5]"
                                      }`}>
                                        <span className={isNewlyLearned ? "text-blue-500 font-bold" : v ? "text-emerald-500" : "text-[#c8b89a]"}>
                                          {isNewlyLearned ? "↗" : v ? "✓" : "✗"}
                                        </span>
                                        <span className={isNewlyLearned ? "text-blue-800 font-medium" : v ? "text-[#1c1410]" : "text-[#a09282]"}>
                                          {k.replace(/_/g, " ")}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Internal voice */}
                            {phase.internal_voice && (
                              <div className="px-5 pb-5 border-t border-[#e8e0d5] pt-4">
                                <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-semibold">Inner voice</div>
                                <p className="text-sm text-[#6b5c4e] leading-relaxed italic border-l-2 pl-3" style={{ borderColor: color + "60" }}>
                                  {phase.internal_voice}
                                </p>
                              </div>
                            )}

                            {/* Knowledge events in this phase */}
                            {phaseKE.length > 0 && (
                              <div className="px-5 pb-5 border-t border-[#e8e0d5] pt-4">
                                <div className="text-xs text-[#c07820] uppercase tracking-widest mb-3 font-semibold">Knowledge gained this phase</div>
                                <div className="space-y-2">
                                  {phaseKE.map((ke, ki) => (
                                    <div key={ki} className="flex gap-3 items-start">
                                      <div className="w-5 h-5 rounded-full bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center shrink-0 mt-0.5">
                                        <span className="text-xs text-[#c07820] font-bold">↗</span>
                                      </div>
                                      <div>
                                        <div className="text-xs font-medium text-[#1c1410]">{ke.learns}</div>
                                        <div className="text-xs text-[#c07820] mt-0.5">{toUnit(ke.timeline_position)}</div>
                                        {ke.from_character && (
                                          <div className="text-xs text-[#a09282] mt-0.5">from {ke.from_character}{ke.was_hidden_before ? " · was hidden" : ""}</div>
                                        )}
                                        {ke.impact_on_character && (
                                          <div className="text-xs text-[#6b5c4e] mt-1 italic">{ke.impact_on_character}</div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
