"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8001";

const CHAR_COLORS = [
  { text: "text-[#c07820]",   bg: "bg-[#c07820]",   ring: "ring-[#f0c060]"   },
  { text: "text-blue-700",    bg: "bg-blue-500",    ring: "ring-blue-300"    },
  { text: "text-emerald-700", bg: "bg-emerald-500", ring: "ring-emerald-300" },
  { text: "text-purple-700",  bg: "bg-purple-500",  ring: "ring-purple-300"  },
  { text: "text-pink-700",    bg: "bg-pink-500",    ring: "ring-pink-300"    },
  { text: "text-cyan-700",    bg: "bg-cyan-500",    ring: "ring-cyan-300"    },
  { text: "text-orange-700",  bg: "bg-orange-500",  ring: "ring-orange-300"  },
  { text: "text-red-700",     bg: "bg-red-500",     ring: "ring-red-300"     },
];

export default function DebateViewPage() {
  const { id, debateId } = useParams<{ id: string; debateId: string }>();
  const [debate, setDebate] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/debates/${debateId}`)
      .then((r) => r.json())
      .then((d) => { setDebate(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [debateId]);

  if (loading) return (
    <main className="flex-1 flex items-center justify-center bg-[#f7f3ed]">
      <div className="text-[#a09282] animate-breathe">Loading debate...</div>
    </main>
  );

  if (!debate) return (
    <main className="flex-1 flex items-center justify-center bg-[#f7f3ed]">
      <div className="text-red-500">Debate not found.</div>
    </main>
  );

  const chars: string[] = debate.participating_characters || [];
  const colorOf = (name: string) => CHAR_COLORS[chars.indexOf(name) % CHAR_COLORS.length] || CHAR_COLORS[0];
  const initials = (name: string) => name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <main className="flex-1 bg-[#f7f3ed]">
      {/* Sub-header */}
      <div className="bg-white border-b border-[#e8e0d5]">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors">
            ← Back to story
          </Link>
          <span className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${
            debate.status === "completed"
              ? "border-emerald-200 text-emerald-700 bg-emerald-50"
              : debate.status === "running"
              ? "border-[#f0c060] text-[#c07820] bg-[#fef3e2] animate-breathe"
              : "border-[#e8e0d5] text-[#a09282] bg-[#f7f3ed]"
          }`}>
            {debate.status === "completed" ? "✓ completed" : debate.status}
          </span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        {/* Scenario */}
        <div className="bg-white border border-[#e8e0d5] rounded-2xl p-5">
          <div className="text-xs text-[#a09282] uppercase tracking-widest mb-2 font-medium">What if?</div>
          <p className="text-[#1c1410] leading-relaxed text-base italic">"{debate.divergence_description}"</p>
          <div className="flex flex-wrap gap-2 pt-3 border-t border-[#e8e0d5] mt-3">
            {chars.map((c) => {
              const col = colorOf(c);
              return (
                <span key={c} className={`text-xs font-medium ${col.text} bg-[#f7f3ed] px-2 py-0.5 rounded-full border border-[#e8e0d5]`}>
                  {c}
                </span>
              );
            })}
          </div>
        </div>

        {/* Running notice */}
        {debate.status === "running" && (
          <div className="text-[#c07820] text-sm text-center py-2 bg-[#fef3e2] border border-[#f0c060]/50 rounded-xl animate-breathe">
            Debate in progress — refresh to see latest turns
          </div>
        )}

        {/* Transcript */}
        <div className="space-y-1">
          {(debate.transcript || []).map((entry: any, i: number) => {
            const c = colorOf(entry.character);
            return (
              <div key={i} className="flex gap-3 py-2.5">
                <div className={`w-8 h-8 rounded-full ${c.bg} shrink-0 flex items-center justify-center text-white font-bold text-xs mt-0.5 ring-2 ring-offset-2 ring-offset-[#f7f3ed] ${c.ring}`}>
                  {initials(entry.character)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-semibold mb-1 ${c.text}`}>{entry.character}</div>
                  <div className="text-[#6b5c4e] text-sm leading-relaxed">{entry.message}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Alternate Ending */}
        {debate.alternate_ending && (
          <div className="border-t border-[#e8e0d5] pt-8 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-[#c07820] text-sm">
                ✍
              </div>
              <h2 className="font-bold text-[#1c1410] text-lg">The Alternate Ending</h2>
            </div>
            <div className="bg-white border border-[#e8e0d5] rounded-2xl p-6 text-[#6b5c4e] text-sm leading-[1.9] whitespace-pre-wrap italic">
              {debate.alternate_ending}
            </div>
          </div>
        )}

        {/* Start another */}
        <div className="pt-2">
          <Link
            href={`/story/${id}/debate`}
            className="inline-block bg-white hover:bg-[#faf7f2] text-[#6b5c4e] hover:text-[#1c1410] text-sm px-5 py-2.5 rounded-xl border border-[#e8e0d5] hover:border-[#c8b89a] transition-colors"
          >
            Start a new debate →
          </Link>
        </div>
      </div>
    </main>
  );
}
