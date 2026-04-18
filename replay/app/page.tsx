"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayDebate } from "@/lib/types";
import { indexAtTime, timeAtIndex, totalDurationMs } from "@/lib/playback";
import { TurnBubble } from "./components/TurnBubble";
import { OrchestratorCard } from "./components/OrchestratorCard";
import { PhaseBanner } from "./components/PhaseBanner";
import { CastStrip } from "./components/CastStrip";
import { AlternateEnding } from "./components/AlternateEnding";
import { PlaybackControls } from "./components/PlaybackControls";
import { DisclaimerFooter } from "./components/DisclaimerFooter";
import { CloneCTA } from "./components/CloneCTA";

// Bundled at build time — one debate per deploy.
import debateData from "../public/debates/1b03e8ed-ae93-485c-a962-481e97dc8596.json";

const debate = debateData as unknown as ReplayDebate;

export default function ReplayPage() {
  const [turnIndex, setTurnIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showEnding, setShowEnding] = useState(false);

  const elapsedRef = useRef(0);
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const total = debate.transcript.length;

  // Character lookup
  const charMap = useMemo(() => {
    const m = new Map<string, (typeof debate.characters)[number]>();
    for (const c of debate.characters) m.set(c.name, c);
    return m;
  }, []);

  const tick = useCallback((now: number) => {
    if (!lastTickRef.current) lastTickRef.current = now;
    const dt = now - lastTickRef.current;
    lastTickRef.current = now;
    elapsedRef.current += dt;

    const nextIdx = indexAtTime(debate.transcript, elapsedRef.current, speed);
    const totalMs = totalDurationMs(debate.transcript, speed);

    if (elapsedRef.current >= totalMs) {
      setIsPlaying(false);
      setTurnIndex(total - 1);
      setShowEnding(true);
      rafRef.current = null;
      lastTickRef.current = 0;
      return;
    }

    if (nextIdx !== -1) setTurnIndex(nextIdx);
    rafRef.current = requestAnimationFrame(tick);
  }, [speed, total]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = 0;
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, tick]);

  const handleScrub = (index: number) => {
    setTurnIndex(index);
    elapsedRef.current = timeAtIndex(debate.transcript, index, speed);
  };

  const handleRestart = () => {
    setTurnIndex(0);
    elapsedRef.current = 0;
    setShowEnding(false);
    setIsPlaying(true);
  };

  const handleSkipToEnd = () => {
    setIsPlaying(false);
    setTurnIndex(total - 1);
    setShowEnding(true);
  };

  // Render turns up to and including turnIndex, inserting phase banners
  // when the phase changes between consecutive visible turns.
  const visibleTurns = debate.transcript.slice(0, turnIndex + 1);
  const rendered: React.ReactNode[] = [];
  let lastPhase: string | null = null;
  visibleTurns.forEach((turn, i) => {
    if (turn.phase !== lastPhase) {
      rendered.push(<PhaseBanner key={`phase-${i}`} phase={turn.phase} />);
      lastPhase = turn.phase;
    }
    if (turn.isOrchestrator) {
      rendered.push(<OrchestratorCard key={`t-${i}`} turn={turn} />);
    } else {
      const character = charMap.get(turn.character);
      const alignRight = i % 2 === 1;
      rendered.push(
        <TurnBubble key={`t-${i}`} turn={turn}
                    character={character} alignRight={alignRight} />,
      );
    }
  });

  const activeCharacter = debate.transcript[turnIndex]?.character ?? null;

  return (
    <div className="min-h-screen flex flex-col pb-16">
      <header className="px-4 py-3 border-b border-[#e5d7b5] bg-[color:var(--bg-warm)]">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-[color:var(--ink-muted)]">
              WhatIfSabha — Debate Replay
            </div>
            <h1 className="text-lg font-serif text-[color:var(--accent)]">
              {debate.story.title}
              <span className="text-[color:var(--ink-muted)] font-sans text-sm ml-2">
                {debate.story.author && `by ${debate.story.author}`}
              </span>
            </h1>
            <div className="text-sm text-[color:var(--ink-muted)] mt-1">
              What if: {debate.story.divergence}
            </div>
          </div>
          <CloneCTA />
        </div>
      </header>

      <CastStrip characters={debate.characters} activeName={activeCharacter} />

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-6">
        {rendered}
      </main>

      {showEnding && (
        <AlternateEnding
          storyTitle={debate.story.title}
          divergence={debate.story.divergence}
          ending={debate.alternate_ending}
          timeline={debate.alternate_timeline}
          onRestart={handleRestart}
        />
      )}

      <DisclaimerFooter text={debate.disclaimer} />

      <PlaybackControls
        isPlaying={isPlaying}
        speed={speed}
        turnIndex={turnIndex}
        totalTurns={total}
        onTogglePlay={() => setIsPlaying((p) => !p)}
        onSpeedChange={(s) => { setSpeed(s); }}
        onScrub={handleScrub}
        onSkipToEnd={handleSkipToEnd}
      />
    </div>
  );
}
