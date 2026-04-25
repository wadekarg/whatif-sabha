"use client";

import { useState } from "react";

type QA = { question: string; answer: string };

export default function PreRecordedQA({
  heading,
  subject,
  items,
}: {
  heading: string;
  subject: string;
  items: QA[];
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="rounded-xl border border-[#e8dfd2] bg-white overflow-hidden">

      <header className="flex items-baseline gap-3 px-6 pt-5 pb-4 border-b border-[#e8dfd2] bg-[#fef3e2]/50">
        <span className="text-base">🎤</span>
        <div>
          <h3 className="font-serif text-lg text-[#1c1410] leading-none">{heading}</h3>
          <p className="text-xs italic text-[#a09282] mt-1.5">
            Pre-recorded samples. In the full app you can ask {subject} anything live.
          </p>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-[#a09282] italic">
          Pre-recorded Q&A is being captured — check back soon.
        </div>
      ) : (
        <ul className="divide-y divide-[#e8dfd2]">
          {items.map((q, i) => {
            const open = openIdx === i;
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setOpenIdx(open ? null : i)}
                  aria-expanded={open}
                  className="w-full text-left px-6 py-4 flex items-baseline gap-3 hover:bg-[#fdfaf5] transition-colors"
                >
                  <span className={`text-[#c07820] transition-transform inline-block w-3 ${open ? "rotate-90" : ""}`} aria-hidden="true">▸</span>
                  <span className="flex-1 text-[#1c1410] font-medium leading-relaxed">{q.question}</span>
                </button>
                {open && (
                  <div className="px-12 pb-5 -mt-1">
                    <p className="text-xs uppercase tracking-widest text-[#a09282] mb-2">{subject}</p>
                    <p className="text-[#2a1f14] leading-relaxed whitespace-pre-wrap">{q.answer}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-[#e8dfd2] bg-[#faf7f2] px-6 py-4 flex items-center gap-3">
        <span className="text-[#a09282]" aria-hidden="true">🔒</span>
        <span className="text-sm text-[#5a4a38] flex-1">
          Live chat is backend-powered — run the full app to ask your own questions.
        </span>
        <a
          href="https://github.com/wadekarg/whatif-sabha#-quick-start"
          target="_blank"
          rel="noopener"
          className="text-sm font-medium px-3 py-1.5 rounded-full bg-[#c07820] text-white hover:bg-[#a66718] transition-colors whitespace-nowrap"
        >
          Run the app ↗
        </a>
      </div>
    </div>
  );
}
