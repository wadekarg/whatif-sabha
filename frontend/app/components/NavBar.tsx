"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavBar() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const storyMatch = pathname.match(/^\/story\/([^/]+)/);
  const storyId = storyMatch ? storyMatch[1] : null;

  const Logo = () => (
    <Link href="/" className="flex items-center gap-2.5 group shrink-0">
      <div className="w-8 h-8 rounded-xl bg-[#c07820] flex items-center justify-center shadow-sm group-hover:bg-[#a86a18] transition-colors overflow-hidden">
        <span style={{ color: "#fef9c3", fontSize: "28px", lineHeight: 1 }}>☸</span>
      </div>
      <span className="font-bold text-[17px] tracking-tight text-[#1c1410]">
        WhatIf<span className="text-[#c07820]">Sabha</span>
      </span>
    </Link>
  );

  const navLink = (href: string, label: string, active?: boolean) => (
    <Link
      key={href}
      href={href}
      className={`text-xs font-medium transition-colors px-3.5 py-1.5 rounded-full border ${
        active
          ? "bg-[#c07820] text-white border-[#c07820]"
          : "text-[#6b5c4e] hover:text-[#1c1410] border-[#e8e0d5] hover:border-[#c8b89a] bg-white/60 hover:bg-white"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-[#f7f3ed]/95 backdrop-blur-md border-b border-[#e8e0d5]">
      <div className="px-8 lg:px-12 h-14 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1.5">
          {storyId && (
            <>
              {navLink(`/story/${storyId}`, "Story", pathname === `/story/${storyId}`)}
              {navLink(`/story/${storyId}/characters`, "Characters", pathname.includes("/characters"))}
              {navLink(`/story/${storyId}/graph`, "Graph", pathname.includes("/graph"))}
              {navLink(`/story/${storyId}/debate`, "Sabha ⚡", pathname.includes("/debate"))}
              <div className="w-px h-4 bg-[#e8e0d5] mx-1" />
            </>
          )}
          {!isHome && navLink("/", "+ New Story")}
        </div>
      </div>
    </header>
  );
}
