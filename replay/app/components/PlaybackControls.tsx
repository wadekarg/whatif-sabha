interface Props {
  isPlaying: boolean;
  speed: number;
  turnIndex: number;
  totalTurns: number;
  onTogglePlay: () => void;
  onSpeedChange: (speed: number) => void;
  onScrub: (index: number) => void;
  onSkipToEnd: () => void;
}

const SPEEDS = [1, 2, 4] as const;

export function PlaybackControls({
  isPlaying, speed, turnIndex, totalTurns,
  onTogglePlay, onSpeedChange, onScrub, onSkipToEnd,
}: Props) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40
                     bg-[color:var(--bg-warm)] border-t border-[#e5d7b5]
                     px-4 py-2 flex items-center gap-3 shadow-lg">
      <button onClick={onTogglePlay}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="w-10 h-10 rounded-full bg-[color:var(--accent)]
                          text-white flex items-center justify-center text-lg">
        {isPlaying ? "⏸" : "▶"}
      </button>

      <div className="flex-1 flex items-center gap-2">
        <span className="text-xs text-[color:var(--ink-muted)] tabular-nums w-14 text-right">
          {turnIndex + 1} / {totalTurns}
        </span>
        <input type="range"
               min={0}
               max={Math.max(0, totalTurns - 1)}
               value={turnIndex}
               onChange={(e) => onScrub(Number(e.target.value))}
               className="flex-1 accent-[color:var(--accent)]"
               aria-label="Scrub to turn" />
      </div>

      <div className="flex items-center gap-1">
        {SPEEDS.map((s) => (
          <button key={s}
                  onClick={() => onSpeedChange(s)}
                  className={`px-2 py-1 text-xs rounded
                               ${speed === s
                                 ? "bg-[color:var(--accent)] text-white"
                                 : "text-[color:var(--ink-muted)] hover:bg-[#ead9b4]"}`}>
            {s}×
          </button>
        ))}
      </div>

      <button onClick={onSkipToEnd}
              className="px-3 py-1 text-xs rounded border border-[color:var(--ink-muted)]
                          text-[color:var(--ink-muted)] hover:bg-[#ead9b4]">
        Skip to end
      </button>
    </div>
  );
}
