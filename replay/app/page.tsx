import Link from "next/link";
import { story } from "./lib/data";
import PreRecordedQA from "./components/PreRecordedQA";

export const metadata = {
  title: `${story.title} — WhatIfSabha Demo`,
  description: story.tagline,
};

export default function StoryHome() {
  return (
    <main className="max-w-4xl mx-auto px-6 py-12">

      <header className="border-b border-[#e8dfd2] pb-10 mb-10">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold text-[#c07820] mb-3">
          Bundled demo
        </p>
        <h1 className="font-serif text-5xl leading-tight mb-3 text-[#1c1410]">
          {story.title}
        </h1>
        <p className="text-[#5a4a38] text-lg italic mb-4">{story.author}</p>
        <p className="text-[#2a1f14] leading-relaxed">{story.tagline}</p>
        <div className="mt-6 inline-flex items-center gap-3 rounded-full bg-[#fef3e2] border border-[#e8dfd2] px-4 py-2 text-sm">
          <span className="text-[#c07820]">⤷</span>
          <span className="text-[#2a1f14]">
            <span className="font-medium">Divergence:</span> {story.demo_divergence}
          </span>
        </div>
      </header>

      <section className="mb-12">
        <h2 className="font-serif text-2xl mb-3 text-[#1c1410]">Synopsis</h2>
        <p className="leading-relaxed text-[#2a1f14] text-[17px]">{story.synopsis}</p>
      </section>

      <section className="mb-12">
        <h2 className="font-serif text-2xl mb-4 text-[#1c1410]">Original timeline</h2>
        <ol className="space-y-3 border-l-2 border-[#e8dfd2] pl-6">
          {story.timeline.map((t, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[34px] top-1 w-3 h-3 rounded-full bg-[#c07820]" aria-hidden="true" />
              <p className="text-xs uppercase tracking-widest text-[#a09282] mb-1">{t.era}</p>
              <p className="text-[#2a1f14] leading-relaxed">{t.event}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mb-12">
        <h2 className="font-serif text-2xl mb-4 text-[#1c1410]">Cast</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {story.cast.map((c) => (
            <Link
              key={c.slug}
              href={`/characters/${c.slug}/`}
              className="group flex flex-col items-center gap-2 p-3 rounded-md border border-[#e8dfd2] bg-white hover:border-[#c07820] transition-colors"
            >
              {c.portrait_url ? (
                <img src={c.portrait_url} alt={c.name} className="w-16 h-16 rounded-full object-cover" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-[#f0e9dd] flex items-center justify-center text-[#a09282] font-serif text-xl">
                  {c.name[0]}
                </div>
              )}
              <p className="text-sm font-medium text-[#1c1410] group-hover:text-[#c07820]">{c.name}</p>
              <p className="text-xs text-[#a09282] capitalize">{c.role}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <PreRecordedQA
          heading="Ask Boru about the book"
          subject="Boru"
          items={story.qa}
        />
      </section>

      <footer className="border-t border-[#e8dfd2] pt-8 mt-12 text-center">
        <Link href="/debate/" className="inline-block px-6 py-3 rounded-full bg-[#1c1410] text-[#f5ecd9] hover:bg-[#c07820] transition-colors">
          Watch the debate →
        </Link>
      </footer>
    </main>
  );
}
