import type { ReplayCharacter } from "@/lib/types";

interface Props {
  characters: ReplayCharacter[];
  activeName: string | null;
}

export function CastStrip({ characters, activeName }: Props) {
  return (
    <div className="flex gap-3 overflow-x-auto py-3 px-4 border-b border-[#e5d7b5]">
      {characters.map((c) => {
        const active = c.name === activeName;
        return (
          <div key={c.name}
               className={`flex flex-col items-center min-w-[60px] transition-opacity
                           ${active ? "opacity-100" : "opacity-40"}`}>
            <img src={c.portrait_url} alt={c.name}
                 className={`w-12 h-12 rounded-full object-cover border-2
                             ${active ? "scale-110" : ""}`}
                 style={{ borderColor: c.color }}
                 onError={(e) => {
                   const img = e.target as HTMLImageElement;
                   img.src = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect width='48' height='48' fill='${encodeURIComponent(c.color)}'/><text x='50%' y='55%' text-anchor='middle' fill='white' font-size='20' font-family='sans-serif'>${c.name[0] ?? "?"}</text></svg>`;
                 }} />
            <span className="text-xs mt-1 text-[color:var(--ink)] truncate max-w-[60px]">
              {c.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
