import Link from "next/link";
import Footer from "../components/Footer";
import { listAllCharacters } from "../lib/data";

const ROLE_STYLE: Record<string, { border: string; text: string; dot: string; bg: string }> = {
  protagonist: { border: "border-l-[#c07820]", text: "text-[#c07820]", dot: "bg-[#c07820]", bg: "#c07820" },
  antagonist:  { border: "border-l-red-400",    text: "text-red-600",   dot: "bg-red-400",    bg: "#ef4444" },
  supporting:  { border: "border-l-blue-400",   text: "text-blue-600",  dot: "bg-blue-400",   bg: "#3b82f6" },
  minor:       { border: "border-l-[#a09282]",  text: "text-[#a09282]", dot: "bg-[#a09282]",  bg: "#a09282" },
  moderator:   { border: "border-l-[#a855f7]",  text: "text-[#a855f7]", dot: "bg-[#a855f7]",  bg: "#a855f7" },
};

export const metadata = {
  title: "Characters — WhatIfSabha Demo",
  description: "The cast of the bundled Animal Farm demo.",
};

export default function CharactersIndex() {
  const chars = listAllCharacters();
  const sorted = [...chars].sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5));

  return (
    <main className="flex flex-col overflow-hidden bg-[#f7f3ed]" style={{ height: "calc(100vh - 56px)" }}>
      <div className="shrink-0 bg-white border-b border-[#e8e0d5]">
        <div className="px-8 lg:px-12 py-4 flex items-center gap-4">
          <Link href="/" className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors">
            ← Back
          </Link>
          <div className="w-px h-4 bg-[#e8e0d5]" />
          <h1 className="text-xl font-bold text-[#1c1410]">Characters</h1>
          <span className="text-xs text-[#a09282] bg-[#f0ebe4] border border-[#e8e0d5] px-2 py-0.5 rounded-full">
            {chars.length}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-8 lg:px-12 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {sorted.map((c) => {
            const s = ROLE_STYLE[c.role] || ROLE_STYLE.minor;
            const importance = Math.round((c.importance ?? 0.5) * 100);
            const initials = c.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
            return (
              <Link key={c.slug} href={`/characters/${c.slug}/`}
                className={`group block border border-[#e8e0d5] border-l-4 ${s.border} rounded-2xl p-5 transition-all duration-200 hover:scale-[1.01] bg-white hover:shadow-md hover:border-[#c8b89a]`}>
                <div className="flex items-start gap-3">
                  {c.portrait_url ? (
                    <img src={c.portrait_url} alt={c.name}
                      className="w-11 h-11 rounded-xl object-cover shrink-0 shadow-sm border border-[#e8e0d5]" />
                  ) : (
                    <div className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: s.bg }}>
                      {initials}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.dot}`} />
                      <h2 className="text-base font-semibold truncate text-[#1c1410]">{c.name}</h2>
                    </div>
                    <div className={`text-xs uppercase tracking-widest mt-1 ml-5 font-medium ${s.text} capitalize`}>
                      {c.role}
                    </div>
                  </div>
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
        </div>
        <Footer />
      </div>
    </main>
  );
}
