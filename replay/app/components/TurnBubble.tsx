import type { ReplayCharacter, ReplayTurn } from "@/lib/types";
import { getEmotionStyle } from "@/lib/emotion";

interface Props {
  turn: ReplayTurn;
  character: ReplayCharacter | undefined;
  alignRight: boolean;
}

export function TurnBubble({ turn, character, alignRight }: Props) {
  const emotion = getEmotionStyle(turn.emotion);
  const color = character?.color ?? "#6b5a42";

  return (
    <div className={`flex ${alignRight ? "justify-end" : "justify-start"} my-3`}>
      <div
        className="max-w-[75%] rounded-2xl px-4 py-3 shadow-sm border"
        style={{
          background: emotion.bg,
          borderColor: color + "40",
          borderLeftWidth: alignRight ? 1 : 4,
          borderRightWidth: alignRight ? 4 : 1,
          borderLeftColor: color,
          borderRightColor: color,
        }}
      >
        <div className="flex items-center gap-2 text-sm font-medium mb-1"
             style={{ color }}>
          {character?.portrait_url && (
            <img src={character.portrait_url} alt=""
                 className="w-6 h-6 rounded-full object-cover"
                 onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          )}
          <span>{turn.character}</span>
          {turn.target_character && (
            <span className="text-xs text-[color:var(--ink-muted)]">
              → {turn.target_character}
            </span>
          )}
          {emotion.label && (
            <span className="ml-auto text-xs inline-flex items-center gap-1"
                  style={{ color: emotion.dot }}>
              <span className="w-2 h-2 rounded-full inline-block"
                    style={{ background: emotion.dot }} />
              {emotion.label}
            </span>
          )}
        </div>
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
          {turn.message}
        </p>
      </div>
    </div>
  );
}
