import type { ReplayTurn } from "@/lib/types";

interface Props {
  turn: ReplayTurn;
}

export function OrchestratorCard({ turn }: Props) {
  return (
    <div className="my-4 flex justify-center">
      <div className="max-w-[80%] rounded-xl px-5 py-4 bg-[#f3e7c9] border border-[#d9b96c] shadow-sm">
        <div className="text-xs uppercase tracking-wide text-[#8a6a1f] font-semibold mb-1">
          🐘 Boru — {turn.orchestratorEvent ?? "host"}
        </div>
        <p className="text-[15px] leading-relaxed text-[#3a2e18] whitespace-pre-wrap">
          {turn.message}
        </p>
      </div>
    </div>
  );
}
