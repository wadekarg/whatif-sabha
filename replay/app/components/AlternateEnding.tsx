import ReactMarkdown from "react-markdown";
import type { ReplayTimelineEvent } from "@/lib/types";

interface Props {
  storyTitle: string;
  divergence: string;
  ending: string;
  timeline: ReplayTimelineEvent[];
  onRestart: () => void;
}

export function AlternateEnding({
  storyTitle, divergence, ending, timeline, onRestart,
}: Props) {
  return (
    <div className="fixed inset-0 bg-[color:var(--bg)] z-50 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="text-xs uppercase tracking-[0.3em] text-[color:var(--ink-muted)] mb-2">
          Alternate Ending — {storyTitle}
        </div>
        <h1 className="font-serif text-3xl text-[color:var(--accent)] mb-6">
          What if {divergence.toLowerCase().replace(/\.$/, "")}?
        </h1>

        <article className="prose prose-lg font-serif text-[color:var(--ink)]
                             leading-relaxed">
          <ReactMarkdown>{ending}</ReactMarkdown>
        </article>

        {timeline.length > 0 && (
          <div className="mt-12">
            <h2 className="text-sm uppercase tracking-wide text-[color:var(--ink-muted)] mb-4">
              Alternate Timeline
            </h2>
            <ol className="space-y-3">
              {timeline.map((ev, i) => (
                <li key={i} className="pl-4 border-l-2 border-[color:var(--accent)]">
                  <div className="text-[15px]">{String(ev.event ?? "")}</div>
                  {ev.chapter_ref ? (
                    <div className="text-xs text-[color:var(--ink-muted)]">
                      {String(ev.chapter_ref)}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mt-12 flex gap-3">
          <button onClick={onRestart}
                  className="px-4 py-2 rounded-lg bg-[color:var(--accent)] text-white font-medium">
            Replay from start
          </button>
        </div>
      </div>
    </div>
  );
}
