"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8001";

const ROLE_STYLE: Record<string, { border: string; bg: string; text: string; dot: string }> = {
  protagonist: { border: "border-l-[#c07820]",  bg: "bg-white",  text: "text-[#c07820]",  dot: "bg-[#c07820]"  },
  antagonist:  { border: "border-l-red-400",     bg: "bg-white",  text: "text-red-600",    dot: "bg-red-400"    },
  supporting:  { border: "border-l-blue-400",    bg: "bg-white",  text: "text-blue-600",   dot: "bg-blue-400"   },
  neutral:     { border: "border-l-[#a09282]",   bg: "bg-white",  text: "text-[#a09282]",  dot: "bg-[#a09282]"  },
};

export default function CharactersPage() {
  const { id } = useParams<{ id: string }>();
  const [characters, setCharacters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/stories/${id}/characters`)
      .then((r) => r.json())
      .then((data) => { setCharacters(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  const sorted = [...characters].sort((a, b) => (b.importance || 0) - (a.importance || 0));

  return (
    <main className="flex flex-col overflow-hidden bg-[#f7f3ed]" style={{ height: "calc(100vh - 56px)" }}>
      <div className="shrink-0 bg-white border-b border-[#e8e0d5]">
        <div className="px-8 lg:px-12 py-4 flex items-center gap-4">
          <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors">
            ← Back
          </Link>
          <div className="w-px h-4 bg-[#e8e0d5]" />
          <h1 className="text-xl font-bold text-[#1c1410]">Characters</h1>
          {!loading && (
            <span className="text-xs text-[#a09282] bg-[#f0ebe4] border border-[#e8e0d5] px-2 py-0.5 rounded-full">
              {characters.length}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 lg:px-12 py-8">
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4, 6, 8].map(i => (
              <div key={i} className="bg-white border border-[#e8e0d5] rounded-2xl h-28 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {sorted.map((c, i) => {
              const s = ROLE_STYLE[c.role] || ROLE_STYLE.neutral;
              const importance = Math.round((c.importance || 0.5) * 100);
              return (
                <Link
                  key={`${i}-${c.name}`}
                  href={`/story/${id}/characters/${encodeURIComponent(c.name).replace(/\./g, "%2E")}`}
                  style={{ animationDelay: `${i * 0.05}s`, opacity: 0 }}
                  className={`group block border border-[#e8e0d5] border-l-4 ${s.border} rounded-2xl p-5 transition-all duration-200 hover:scale-[1.01] animate-fade-up bg-white hover:shadow-md hover:border-[#c8b89a]`}
                >
                  <div className="flex items-start gap-3">
                    {/* Portrait */}
                    {c.portrait ? (
                      <img src={`http://localhost:8001${c.portrait}`} alt={c.name} loading="lazy"
                        className="w-11 h-11 rounded-xl object-cover shrink-0 shadow-sm border border-[#e8e0d5] group-hover:scale-105 transition-transform"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    ) : (
                      <div className={`w-11 h-11 rounded-xl shrink-0 flex items-center justify-center text-white font-bold text-sm`}
                        style={{ backgroundColor: ({ protagonist: "#c07820", antagonist: "#ef4444", supporting: "#3b82f6", neutral: "#78716c" } as Record<string, string>)[c.role] || "#78716c" }}>
                        {c.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.dot}`} />
                        <h2 className="text-base font-semibold truncate text-[#1c1410]">{c.name}</h2>
                        {c.fair_witness && (
                          <span className="text-xs text-[#c07820] shrink-0">✦</span>
                        )}
                      </div>
                      <div className={`text-xs uppercase tracking-widest mt-1 ml-5 font-medium ${s.text}`}>
                        {c.role}
                      </div>
                    </div>
                    {/* Importance ring */}
                    <div className="relative w-10 h-10 shrink-0">
                      <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                        <circle cx="18" cy="18" r="15" fill="none" stroke="#f0ebe4" strokeWidth="2.5" />
                        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="2.5"
                          strokeDasharray={`${importance * 0.942} 94.2`} strokeLinecap="round"
                          className={s.text} stroke="currentColor" />
                      </svg>
                      <div className={`absolute inset-0 flex items-center justify-center text-xs font-bold ${s.text}`}>
                        {importance}
                      </div>
                    </div>
                  </div>
                  {c.description && (
                    <p className="mt-3 text-sm text-[#6b5c4e] line-clamp-2 leading-relaxed group-hover:text-[#1c1410] transition-colors ml-5">
                      {c.description}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
