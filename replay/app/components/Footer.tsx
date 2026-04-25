// Demo-wide footer — editorial masthead style.
export default function Footer() {
  return (
    <footer className="bg-[#faf7f2] border-t border-[#e8e0d5] py-5 px-6 text-center">
      <div className="flex items-center justify-center gap-2 text-[#1c1410]">
        <span className="w-5 h-5 rounded-md bg-[#c07820] flex items-center justify-center" style={{ fontSize: "16px", lineHeight: 1, color: "#fef9c3" }}>☸</span>
        <span className="font-semibold tracking-[0.18em] uppercase text-[13px]">WhatIf<span className="text-[#c07820]">Sabha</span></span>
      </div>
      <div className="italic text-[#a09282] text-xs mt-1.5 mb-3">what if things had gone differently?</div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-[#a09282]">
        <a href="https://github.com/wadekarg/whatif-sabha" target="_blank" rel="noopener noreferrer" className="hover:text-[#c07820] transition-colors flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          GitHub
        </a>
        <span className="text-[#e8e0d5]">/</span>
        <a href="https://wadekarg.github.io/" target="_blank" rel="noopener noreferrer" className="hover:text-[#c07820] transition-colors">@wadekarg</a>
        <span className="text-[#e8e0d5]">/</span>
        <a href="https://www.linkedin.com/in/gajananwadekar/" target="_blank" rel="noopener noreferrer" className="hover:text-[#c07820] transition-colors flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>
          LinkedIn
        </a>
        <span className="text-[#e8e0d5]">/</span>
        <span className="text-[#c8b89a]">MIT</span>
      </div>
    </footer>
  );
}
