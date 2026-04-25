"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

type CharacterEntry = { slug: string; name: string };

export default function TopNav() {
  const pathname = usePathname();
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [castOpen, setCastOpen] = useState(false);

  // Lazy-load the character list once for the dropdown. Static import would
  // pull characters.json into every page bundle; this keeps it client-only.
  useEffect(() => {
    fetch("/characters.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const list: CharacterEntry[] = Object.entries(data).map(
          ([slug, value]: [string, any]) => ({ slug, name: value.name ?? slug })
        );
        setCharacters(list);
      })
      .catch(() => { /* characters.json may not exist yet during early dev */ });
  }, []);

  const isStory     = pathname === "/" || pathname === "";
  const isCharacter = pathname?.startsWith("/characters") ?? false;
  const isDebate    = pathname?.startsWith("/debate") ?? false;

  const linkBase = "px-3 py-1.5 rounded-full text-sm transition-colors";
  const active   = "bg-[#1c1410] text-[#f5ecd9]";
  const idle     = "text-[#5a4a38] hover:bg-[#f0e9dd]";

  return (
    <header className="sticky top-0 z-30 bg-[#faf7f2]/95 backdrop-blur border-b border-[#e8dfd2]">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-6">
        <Link href="/" className="font-serif text-lg font-medium text-[#1c1410]">
          WhatIf<span className="text-[#c07820]">Sabha</span>
        </Link>

        <nav className="flex items-center gap-1 ml-4">
          <Link href="/" className={`${linkBase} ${isStory ? active : idle}`}>Story</Link>

          <div
            className="relative"
            onMouseEnter={() => setCastOpen(true)}
            onMouseLeave={() => setCastOpen(false)}
          >
            <button
              type="button"
              className={`${linkBase} ${isCharacter ? active : idle}`}
              onClick={() => setCastOpen((v) => !v)}
              aria-expanded={castOpen}
              aria-haspopup="true"
            >
              Characters {characters.length > 0 && <span className="opacity-60">▾</span>}
            </button>
            {castOpen && characters.length > 0 && (
              <div className="absolute left-0 top-full mt-1 min-w-48 bg-white border border-[#e8dfd2] rounded-md shadow-lg py-1 max-h-80 overflow-y-auto">
                {characters.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/characters/${c.slug}/`}
                    className="block px-3 py-1.5 text-sm text-[#2a1f14] hover:bg-[#f0e9dd]"
                  >
                    {c.name}
                  </Link>
                ))}
              </div>
            )}
          </div>

          <Link href="/debate/" className={`${linkBase} ${isDebate ? active : idle}`}>Debate</Link>
        </nav>

        <a
          href="https://github.com/wadekarg/whatif-sabha#-quick-start"
          target="_blank"
          rel="noopener"
          className="ml-auto px-3 py-1.5 rounded-full bg-[#c07820] text-white text-sm font-medium hover:bg-[#a66718] transition-colors"
        >
          Run the app ↗
        </a>
      </div>
    </header>
  );
}
