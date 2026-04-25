import type { CharacterDossier } from "../../lib/data";

export default function CharacterQA({
  character,
  bubbleColor,
}: {
  character: CharacterDossier;
  bubbleColor: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">🎤</div>
        <div className="text-sm font-semibold text-[#1c1410]">Ask {character.name}</div>
        <div className="flex-1 h-px bg-[#e8e0d5]" />
        <span className="text-[10px] uppercase tracking-widest text-[#c07820] font-semibold bg-[#fef3e2] border border-[#f0c060]/50 px-2 py-0.5 rounded-full">Pre-recorded</span>
      </div>

      <div className="bg-white border border-[#e8e0d5] rounded-2xl p-4 space-y-3">
        {character.qa.length === 0 ? (
          <p className="text-center text-[#a09282] text-sm italic py-6 px-4 leading-relaxed">
            No pre-recorded samples for {character.name} yet. In the full app you could ask them anything live.
          </p>
        ) : (
          character.qa.map((qa, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-br-sm text-sm leading-relaxed text-white" style={{ backgroundColor: bubbleColor }}>
                  {qa.question}
                </div>
              </div>
              <div className="flex gap-2 justify-start">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 mt-0.5" style={{ backgroundColor: bubbleColor }}>
                  {character.name[0]}
                </div>
                <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] text-sm leading-relaxed whitespace-pre-wrap">
                  {qa.answer}
                </div>
              </div>
            </div>
          ))
        )}

        <div className="pt-3 border-t border-[#e8e0d5]">
          <div className="flex gap-2 items-end opacity-55 pointer-events-none select-none">
            <div className="flex-1 bg-[#f7f3ed] border border-[#e8e0d5] rounded-xl px-3.5 py-2.5 text-sm text-[#a09282] leading-relaxed">
              🔒 Ask {character.name}…
            </div>
            <div className="w-10 h-10 rounded-xl bg-[#e8e0d5] text-[#c8b89a] flex items-center justify-center text-lg shrink-0">↑</div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-[#a09282] flex-1">Live chat is backend-powered.</span>
            <a href="https://github.com/wadekarg/whatif-sabha#-quick-start" target="_blank" rel="noopener"
              className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#c07820] text-white hover:bg-[#a86a18] transition-colors whitespace-nowrap">
              Run the app ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
