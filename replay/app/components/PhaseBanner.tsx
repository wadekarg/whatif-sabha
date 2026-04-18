interface Props {
  phase: string;
}

const PHASE_LABELS: Record<string, string> = {
  opening: "Opening",
  cross_examination: "Cross-Examination",
  deepening: "Deepening",
  reckoning: "Reckoning",
};

export function PhaseBanner({ phase }: Props) {
  const label = PHASE_LABELS[phase] ?? phase;
  return (
    <div className="my-8 flex justify-center">
      <div className="text-center">
        <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--ink-muted)] mb-1">
          Phase
        </div>
        <div className="text-2xl font-serif text-[color:var(--accent)]">
          {label}
        </div>
        <div className="mt-2 h-px w-24 mx-auto bg-[color:var(--accent)] opacity-40" />
      </div>
    </div>
  );
}
