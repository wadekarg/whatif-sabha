"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

export default function TopNav() {
  const pathname = usePathname() || "/";

  const isStory      = pathname === "/" || pathname === "";
  const isCharacters = pathname.startsWith("/characters");
  const isDebate     = pathname.startsWith("/debate");

  const Logo = () => (
    <Link href="/" className="flex items-center gap-2.5 group shrink-0">
      <div className="w-8 h-8 rounded-xl bg-[#c07820] flex items-center justify-center shadow-sm group-hover:bg-[#a86a18] transition-colors overflow-hidden">
        <span style={{ color: "#fef9c3", fontSize: "28px", lineHeight: 1 }}>☸</span>
      </div>
      <span className="font-bold text-lg tracking-tight text-[#1c1410]">
        WhatIf<span className="text-[#c07820]">Sabha</span>
      </span>
    </Link>
  );

  const navLinkCls = (active: boolean) =>
    `text-sm font-medium transition-colors px-4 py-2 rounded-full border ${
      active
        ? "bg-[#c07820] text-white border-[#c07820]"
        : "text-[#6b5c4e] hover:text-[#1c1410] border-[#e8e0d5] hover:border-[#c8b89a] bg-white/60 hover:bg-white"
    }`;

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-[#f7f3ed]/95 backdrop-blur-md border-b border-[#e8e0d5]">
      <div className="px-8 lg:px-12 h-14 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1.5">
          <Link href="/" className={navLinkCls(isStory)}>Story</Link>
          <Link href="/characters/" className={navLinkCls(isCharacters)}>Characters</Link>
          <Link href="/debate/" className={navLinkCls(isDebate)}>Debate ⚡</Link>
          <div className="w-px h-4 bg-[#e8e0d5] mx-1" />
          <a href="https://github.com/wadekarg/whatif-sabha" target="_blank" rel="noopener"
            className="text-sm font-medium transition-colors px-4 py-2 rounded-full border text-[#6b5c4e] hover:text-[#1c1410] border-[#e8e0d5] hover:border-[#c8b89a] bg-white/60 hover:bg-white">
            GitHub repo ↗
          </a>
        </div>
      </div>
    </header>
  );
}
