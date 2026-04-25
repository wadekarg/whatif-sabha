import Link from "next/link";
import { notFound } from "next/navigation";
import { characters, getCharacter, listAllCharacters, CHAR_COLORS } from "../../lib/data";
import CharacterQA from "./CharacterQA";
import CharacterArcView from "./CharacterArcView";

const ROLE_COLOR: Record<string, string> = {
  protagonist: "#c07820",
  antagonist:  "#ef4444",
  supporting:  "#3b82f6",
  minor:       "#a09282",
  moderator:   "#a855f7",
};

export function generateStaticParams() {
  return Object.keys(characters).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = getCharacter(slug);
  if (!c) return { title: "Character — WhatIfSabha Demo" };
  return {
    title: `${c.name} — WhatIfSabha Demo`,
    description: c.description.slice(0, 160),
  };
}

export default async function CharacterDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const character = getCharacter(slug);
  if (!character) notFound();

  const all = listAllCharacters();
  const idx = all.findIndex(c => c.slug === slug);
  const color = ROLE_COLOR[character.role] || "#6b5c4e";
  const initials = character.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const bubbleColor = CHAR_COLORS[idx % CHAR_COLORS.length];

  const prev = all[(idx - 1 + all.length) % all.length];
  const next = all[(idx + 1) % all.length];

  return (
    <main className="flex flex-col overflow-hidden bg-[#f7f3ed]" style={{ height: "calc(100vh - 56px)" }}>

      {/* Header strip */}
      <div className="shrink-0 bg-white border-b border-[#e8e0d5]">
        <div className="px-8 lg:px-12 py-4 flex items-center gap-4">
          <Link href="/characters/" className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors shrink-0">
            ← Characters
          </Link>
          <div className="w-px h-4 bg-[#e8e0d5]" />
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0" style={{ backgroundColor: color }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-[#1c1410]">{character.name}</h1>
              <span className="text-xs uppercase tracking-widest px-2.5 py-0.5 rounded-full border font-semibold capitalize"
                style={{ color, borderColor: color + "44", backgroundColor: color + "11" }}>
                {character.role}
              </span>
            </div>
            <p className="text-[#6b5c4e] text-xs leading-relaxed mt-0.5 truncate max-w-2xl">{character.description}</p>
          </div>
          <Link href="/debate/" className="shrink-0 flex items-center gap-2 bg-[#c07820] hover:bg-[#a86a18] text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors shadow-sm">
            ⚡ Debate
          </Link>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 lg:px-12 py-8 space-y-8">

          {/* Hero — portrait image if present, else initials */}
          <div className="flex items-start gap-6">
            {character.portrait_url ? (
              <img src={character.portrait_url} alt={character.name}
                className="w-32 h-32 rounded-2xl object-cover shadow-md border-2 border-[#e8e0d5] shrink-0" />
            ) : (
              <div className="w-32 h-32 rounded-2xl flex items-center justify-center text-white font-bold text-4xl shadow-md border-2 border-[#e8e0d5] shrink-0" style={{ backgroundColor: color }}>
                {initials}
              </div>
            )}
            <div className="flex-1 pt-1">
              <p className="text-[#1c1410] text-sm leading-relaxed">{character.description}</p>
              {character.aliases && character.aliases.length > 0 && (
                <p className="text-xs text-[#a09282] mt-2">
                  Also known as: {character.aliases.join(", ")}
                </p>
              )}
              {character.importance != null && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-xs text-[#a09282]">Importance:</span>
                  <div className="w-24 h-1.5 bg-[#e8e0d5] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(character.importance ?? 0) * 100}%`, backgroundColor: color }} />
                  </div>
                  <span className="text-xs font-medium" style={{ color }}>{Math.round((character.importance ?? 0) * 100)}%</span>
                </div>
              )}
            </div>
          </div>

          {/* Personality traits */}
          {character.personality_traits && character.personality_traits.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest">Personality</div>
              <div className="flex flex-wrap gap-2">
                {character.personality_traits.map(t => (
                  <span key={t} className="text-xs bg-white border border-[#e8e0d5] text-[#6b5c4e] px-3 py-1 rounded-full font-medium capitalize">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Motivations & Fears */}
          {((character.motivations?.length ?? 0) > 0 || (character.fears?.length ?? 0) > 0) && (
            <div className="grid sm:grid-cols-2 gap-4">
              {character.motivations && character.motivations.length > 0 && (
                <div className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                  <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Motivations</div>
                  <ul className="space-y-1.5">
                    {character.motivations.map((m, i) => (
                      <li key={i} className="text-sm text-[#1c1410] leading-snug flex items-start gap-2">
                        <span className="text-[#c07820] shrink-0 mt-0.5" aria-hidden="true">→</span>
                        <span>{m}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {character.fears && character.fears.length > 0 && (
                <div className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                  <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Fears</div>
                  <ul className="space-y-1.5">
                    {character.fears.map((f, i) => (
                      <li key={i} className="text-sm text-[#1c1410] leading-snug flex items-start gap-2">
                        <span className="text-red-400 shrink-0 mt-0.5" aria-hidden="true">⚠</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Internal voice */}
          {character.internal_voice && (
            <div className="bg-[#fef9f0] border border-[#f0c060]/40 rounded-xl p-4">
              <div className="text-xs font-semibold text-[#c07820] uppercase tracking-widest mb-2">✦ Speaks as</div>
              <p className="text-sm text-[#1c1410] leading-relaxed italic">{character.internal_voice}</p>
            </div>
          )}

          {/* Story timeline bar + character arc with phases */}
          <CharacterArcView character={character} />

          {/* Fair witness panel — backend-sourced, adversarial re-reading */}
          {character.fair_witness && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">✦</div>
                <div className="text-sm font-semibold text-[#1c1410]">Fair witness</div>
                <div className="flex-1 h-px bg-[#e8e0d5]" />
                <span className="text-[10px] uppercase tracking-widest text-[#a09282]">A re-reading</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                {character.fair_witness.consensus_view && (
                  <div className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                    <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Consensus view</div>
                    <p className="text-sm text-[#1c1410] leading-relaxed">{character.fair_witness.consensus_view}</p>
                  </div>
                )}
                {character.fair_witness.hidden_motivations && (
                  <div className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                    <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Hidden motivations</div>
                    <p className="text-sm text-[#1c1410] leading-relaxed">{character.fair_witness.hidden_motivations}</p>
                  </div>
                )}
                {character.fair_witness.narrative_bias && (
                  <div className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                    <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Narrative bias</div>
                    <p className="text-sm text-[#1c1410] leading-relaxed">{character.fair_witness.narrative_bias}</p>
                  </div>
                )}
                {character.fair_witness.charitable_reading && (
                  <div className="bg-white border border-[#e8e0d5] rounded-xl p-4">
                    <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Charitable reading</div>
                    <p className="text-sm text-[#1c1410] leading-relaxed">{character.fair_witness.charitable_reading}</p>
                  </div>
                )}
              </div>
              {character.fair_witness.speaks_as && (
                <div className="bg-[#fef9f0] border border-[#f0c060]/40 rounded-xl p-4">
                  <div className="text-xs font-semibold text-[#c07820] uppercase tracking-widest mb-2">Speaks as</div>
                  <p className="text-sm text-[#1c1410] leading-relaxed italic">{character.fair_witness.speaks_as}</p>
                </div>
              )}
              {character.fair_witness.fair_personality_traits && character.fair_witness.fair_personality_traits.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-[#a09282] uppercase tracking-widest mb-2">Fair personality traits</div>
                  <div className="flex flex-wrap gap-2">
                    {character.fair_witness.fair_personality_traits.map(t => (
                      <span key={t} className="text-xs bg-[#fef3e2] border border-[#f0c060]/50 text-[#c07820] px-3 py-1 rounded-full font-medium capitalize">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pre-recorded Q&A */}
          <CharacterQA character={character} bubbleColor={bubbleColor} />

          {/* Prev / next */}
          <div className="flex items-center justify-between pt-4 border-t border-[#e8e0d5] text-sm">
            <Link href={`/characters/${prev.slug}/`} className="text-[#5a4a38] hover:text-[#c07820]">← {prev.name}</Link>
            <Link href="/characters/" className="text-[#a09282] hover:text-[#1c1410]">All characters</Link>
            <Link href={`/characters/${next.slug}/`} className="text-[#5a4a38] hover:text-[#c07820]">{next.name} →</Link>
          </div>

        </div>
      </div>
    </main>
  );
}
