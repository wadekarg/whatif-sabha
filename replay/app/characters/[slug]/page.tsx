import Link from "next/link";
import { notFound } from "next/navigation";
import { characters, getCharacter, listCharacters } from "../../lib/data";
import PreRecordedQA from "../../components/PreRecordedQA";

// Tell Next.js which slugs to prerender at build time.
export function generateStaticParams() {
  return Object.keys(characters).map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const c = getCharacter(params.slug);
  if (!c) return { title: "Character — WhatIfSabha Demo" };
  return {
    title: `${c.name} — WhatIfSabha Demo`,
    description: c.description.slice(0, 160),
  };
}

export default function CharacterPage({ params }: { params: { slug: string } }) {
  const c = getCharacter(params.slug);
  if (!c) notFound();

  const cast = listCharacters();
  const myIdx = cast.findIndex((x) => x.slug === c.slug);
  const prev = cast[(myIdx - 1 + cast.length) % cast.length];
  const next = cast[(myIdx + 1) % cast.length];

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">

      <nav className="mb-8 text-sm">
        <Link href="/" className="text-[#5a4a38] hover:text-[#c07820]">← All characters</Link>
      </nav>

      <header className="flex items-start gap-6 mb-10 pb-10 border-b border-[#e8dfd2]">
        {c.portrait_url ? (
          <img src={c.portrait_url} alt={c.name} className="w-28 h-28 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-28 h-28 rounded-full bg-[#f0e9dd] flex items-center justify-center text-[#a09282] font-serif text-4xl flex-shrink-0">
            {c.name[0]}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-[0.18em] font-semibold text-[#a09282] mb-2 capitalize">{c.role}</p>
          <h1 className="font-serif text-4xl leading-tight text-[#1c1410]">{c.name}</h1>
        </div>
      </header>

      <section className="mb-12">
        <h2 className="font-serif text-xl mb-3 text-[#1c1410]">Who they are</h2>
        <p className="leading-relaxed text-[#2a1f14] text-[17px]">{c.description}</p>
      </section>

      <section className="mb-12">
        <PreRecordedQA
          heading={`Ask ${c.name}`}
          subject={c.name}
          items={c.qa}
        />
      </section>

      <footer className="flex items-center justify-between pt-8 mt-12 border-t border-[#e8dfd2] text-sm">
        <Link href={`/characters/${prev.slug}/`} className="text-[#5a4a38] hover:text-[#c07820]">← {prev.name}</Link>
        <Link href="/" className="text-[#a09282] hover:text-[#1c1410]">All characters</Link>
        <Link href={`/characters/${next.slug}/`} className="text-[#5a4a38] hover:text-[#c07820]">{next.name} →</Link>
      </footer>
    </main>
  );
}
