"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import * as d3 from "d3";
import ReactMarkdown from "react-markdown";
import { API } from "../../../config";
import { exportDebateToPdf } from "../../../lib/exportDebate";

const CHAR_COLORS = [
  { text: "text-[#c07820]",   bg: "bg-[#c07820]",   ring: "ring-[#f0c060]",   hex: "#c07820" },
  { text: "text-blue-700",    bg: "bg-blue-500",    ring: "ring-blue-300",    hex: "#3b82f6" },
  { text: "text-emerald-700", bg: "bg-emerald-500", ring: "ring-emerald-300", hex: "#10b981" },
  { text: "text-purple-700",  bg: "bg-purple-500",  ring: "ring-purple-300",  hex: "#a855f7" },
  { text: "text-pink-700",    bg: "bg-pink-500",    ring: "ring-pink-300",    hex: "#ec4899" },
  { text: "text-cyan-700",    bg: "bg-cyan-500",    ring: "ring-cyan-300",    hex: "#06b6d4" },
  { text: "text-orange-700",  bg: "bg-orange-500",  ring: "ring-orange-300",  hex: "#f97316" },
  { text: "text-red-700",     bg: "bg-red-500",     ring: "ring-red-300",     hex: "#ef4444" },
];

const EMOTION_STYLE: Record<string, { bg: string; label: string; dot: string }> = {
  anger:                { bg: "rgba(254,242,242,0.7)",  label: "anger",        dot: "#ef4444" },
  cold_fury:            { bg: "rgba(69,10,10,0.08)",    label: "cold fury",    dot: "#7f1d1d" },
  contempt:             { bg: "rgba(250,245,255,0.7)",  label: "contempt",     dot: "#a855f7" },
  grief:                { bg: "rgba(239,246,255,0.7)",  label: "grief",        dot: "#60a5fa" },
  desperation:          { bg: "rgba(255,247,237,0.7)",  label: "desperation",  dot: "#f97316" },
  pride:                { bg: "rgba(254,252,232,0.7)",  label: "pride",        dot: "#eab308" },
  guilt:                { bg: "rgba(248,250,252,0.7)",  label: "guilt",        dot: "#94a3b8" },
  shame:                { bg: "rgba(253,242,248,0.7)",  label: "shame",        dot: "#f472b6" },
  defiance:             { bg: "rgba(255,251,235,0.7)",  label: "defiance",     dot: "#f59e0b" },
  bitterness:           { bg: "rgba(250,250,249,0.7)",  label: "bitterness",   dot: "#78716c" },
  jealousy:             { bg: "rgba(240,253,244,0.7)",  label: "jealousy",     dot: "#22c55e" },
  longing:              { bg: "rgba(238,242,255,0.7)",  label: "longing",      dot: "#818cf8" },
  righteous_indignation:{ bg: "rgba(255,241,242,0.7)",  label: "indignation",  dot: "#e11d48" },
  humiliation:          { bg: "rgba(255,241,242,0.5)",  label: "humiliation",  dot: "#fb7185" },
  weariness:            { bg: "rgba(249,250,251,0.7)",  label: "weariness",    dot: "#9ca3af" },
  hope:                 { bg: "rgba(240,253,250,0.7)",  label: "hope",         dot: "#2dd4bf" },
  betrayal:             { bg: "rgba(245,243,255,0.7)",  label: "betrayal",     dot: "#6d28d9" },
  neutral:              { bg: "rgba(255,255,255,0.9)",  label: "",             dot: "#c8b89a" },
};

type DebateEntry = { character: string; message: string; round: number; target?: string; target_characters?: string[]; emotion?: string; judgeScore?: number; isExploration?: boolean; isObserver?: boolean; observerEra?: string; };
type StreamEntry = { character: string; text: string; };
type DivPoint    = { event_id: string; description: string; affected_characters: string[]; };

type GraphNode = { id: string; x: number; y: number; vx: number; vy: number; r: number; color: string; speeches: number; role: string; shape: string; fx?: number | null; fy?: number | null; };
type SpeechAct = "question" | "response" | "statement";
type GraphEdge = { source: string | any; target: string | any; sourceId: string; targetId: string; count: number; questions: number; speech_act?: SpeechAct; };

function classifySpeechAct(message: string, targetCharacters: string[]): SpeechAct {
  if (!targetCharacters || targetCharacters.length === 0) return "statement";
  if (!message || !message.trim()) return "statement";
  if (!message.includes("?")) return "response";

  const questionSentences = message
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().endsWith("?"));

  const targetSet = new Set(targetCharacters.map(t => t.toLowerCase()));

  for (const sent of questionSentences) {
    const sentLower = sent.toLowerCase();
    if ([...targetSet].some(t => sentLower.includes(t))) return "question";
    if (/\b(you|your|you're|yours)\b/.test(sentLower)) return "question";
  }
  return "response";
}

export default function DebatePage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [divergence, setDivergence] = useState(() => searchParams.get("q") || "");
  const [storyTitle, setStoryTitle] = useState("");
  const [suggestions, setSuggestions] = useState<DivPoint[]>([]);
  const [transcript, setTranscript] = useState<DebateEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamEntry | null>(null);
  const [alternateEnding, setAlternateEnding] = useState("");
  const [debateSummary, setDebateSummary] = useState("");
  const [streamingSummary, setStreamingSummary] = useState("");
  const [, setStreamingEnding] = useState("");
  const [alternateTimeline, setAlternateTimeline] = useState<any[]>([]);
  const [showConclusion, setShowConclusion] = useState(false);
  const [oracleReady, setOracleReady] = useState(false);
  const [, setShowOracle] = useState(false);
  const [oracleCharacter, setOracleCharacter] = useState("");
  // Conclusion panel
  const [conclusionTab, setConclusionTab] = useState<"oracle"|"story">("oracle");
  const [storyCharMsgs, setStoryCharMsgs] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [storyCharStreaming, setStoryCharStreaming] = useState("");
  const [storyCharLoading, setStoryCharLoading] = useState(false);
  const [storyCharInput, setStoryCharInput] = useState("");
  const storyCharEndRef = useRef<HTMLDivElement>(null);
  const [oracleInput, setOracleInput] = useState("");
  // Per-character oracle history — keyed by character name. Switching between
  // characters preserves each conversation for the session instead of wiping.
  const [oracleHistories, setOracleHistories] = useState<Record<string, {role:string;content:string;character?:string}[]>>({});
  const oracleHistory = oracleHistories[oracleCharacter] || [];
  const [oracleStreaming, setOracleStreaming] = useState("");
  const [oracleLoading, setOracleLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "done">("idle");
  const [dramaScore, setDramaScore] = useState(0.5);
  const [activeCharacters, setActiveCharacters] = useState<string[]>([]);
  const [storyCharacters, setStoryCharacters] = useState<{name:string;role?:string;importance:number;portrait?:string}[]>([]);
  const [selectedCharacters, setSelectedCharacters] = useState<Set<string>>(new Set());
  const [explorationRates, setExplorationRates] = useState<Record<string,number>>({});
  const [pendingChallenge, setPendingChallenge] = useState<{character: string; observerName: string; question: string} | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [leftTab, setLeftTab] = useState<"debate"|"agents"|"chat">("debate");
  const [rightTab, setRightTab] = useState<"graph"|"ledger"|"positions">("graph");
  const [splitPct, setSplitPct] = useState(55);
  const [maximize, setMaximize] = useState<"none"|"left"|"right">(
    typeof window !== "undefined" && window.innerWidth < 1024 ? "left" : "none"
  );
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [graphLegendCollapsed, setGraphLegendCollapsed] = useState(true);
  const pendingExplorationRef = useRef<string | null>(null);
  const debateClosedCleanlyRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const [chatMessages, setChatMessages] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [audienceName, setAudienceName] = useState("");
  const [audienceInput, setAudienceInput] = useState("");
  const [audienceNameSet, setAudienceNameSet] = useState(false);
  const [chatInput, setChatInput]       = useState("");
  const [chatLoading, setChatLoading]   = useState(false);
  const [debateId, setDebateId]         = useState<string>("");
  const debateIdRef = useRef<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── TTS: generation-based system — one audio at a time, no races ──
  const [ttsPlaying, setTtsPlaying] = useState<number | null>(null);
  const [ttsAutoPlay, setTtsAutoPlay] = useState(true);
  const [ttsLoading, setTtsLoading] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAutoPlayRef = useRef(true);
  const ttsQueueRef = useRef<{idx: number; entry: any}[]>([]);
  const ttsCacheRef = useRef<Map<number, string>>(new Map());
  const ttsFetchingRef = useRef<Set<number>>(new Set());
  const ttsGenRef = useRef(0);  // generation counter — incremented on every stop/new play

  useEffect(() => { ttsAutoPlayRef.current = ttsAutoPlay; }, [ttsAutoPlay]);

  // Prefetch audio (background, no playback)
  const prefetchTTS = (turnIndex: number, entry?: any) => {
    if (ttsCacheRef.current.has(turnIndex)) return;
    if (ttsFetchingRef.current.has(turnIndex)) return;
    if (!debateIdRef.current) return;
    const e = entry || transcriptRef.current[turnIndex];
    if (!e || !e.message || e.isReaction || e.isStageDirection) return;

    ttsFetchingRef.current.add(turnIndex);
    const gen = ttsGenRef.current;

    fetch(`${API}/debates/${debateIdRef.current}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: e.message, character_name: e.character,
        emotion: e.emotion || "neutral", is_orchestrator: !!e.isOrchestrator,
      }),
    })
      .then(res => res.ok ? res.blob() : null)
      .then(blob => {
        ttsFetchingRef.current.delete(turnIndex);
        if (blob) ttsCacheRef.current.set(turnIndex, URL.createObjectURL(blob));
        // Only drain if this generation is still active
        if (gen === ttsGenRef.current && ttsAutoPlayRef.current && !audioRef.current) drainQueue();
      })
      .catch(() => { ttsFetchingRef.current.delete(turnIndex); });
  };

  const stopAllAudio = () => {
    ttsGenRef.current++;  // invalidate all in-flight plays
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    setTtsPlaying(null);
    setTtsLoading(null);
  };

  // Toggle single message — stop if playing, play if not (clears queue)
  const toggleTTS = (turnIndex: number) => {
    if (ttsPlaying === turnIndex) {
      stopAllAudio();
      ttsQueueRef.current = [];
      return;
    }
    // Stop everything, clear queue, play just this one
    stopAllAudio();
    ttsQueueRef.current = [];
    playTTS(turnIndex);
  };

  // Play one turn — checks generation to prevent stale plays
  const playTTS = async (turnIndex: number, entryData?: any) => {
    stopAllAudio();
    const myGen = ttsGenRef.current;

    const entry = entryData || transcriptRef.current[turnIndex];
    if (!entry || !entry.message || entry.isReaction || entry.isStageDirection || !debateIdRef.current) {
      drainQueue(); return;
    }

    setTtsLoading(turnIndex);

    try {
      let blobUrl = ttsCacheRef.current.get(turnIndex);

      if (!blobUrl) {
        const res = await fetch(`${API}/debates/${debateIdRef.current}/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: entry.message, character_name: entry.character,
            emotion: entry.emotion || "neutral", is_orchestrator: !!entry.isOrchestrator,
          }),
        });
        // Check if we were cancelled while fetching
        if (myGen !== ttsGenRef.current) return;
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        const blob = await res.blob();
        if (myGen !== ttsGenRef.current) return;
        blobUrl = URL.createObjectURL(blob);
        ttsCacheRef.current.set(turnIndex, blobUrl);
      }

      // Final generation check before playing
      if (myGen !== ttsGenRef.current) return;

      const audio = new Audio(blobUrl);
      audioRef.current = audio;
      audio.onended = () => {
        if (myGen !== ttsGenRef.current) return;
        audioRef.current = null;
        setTtsPlaying(null);
        drainQueue();
      };
      audio.onerror = () => {
        if (myGen !== ttsGenRef.current) return;
        audioRef.current = null;
        setTtsPlaying(null);
        setTtsLoading(null);
        drainQueue();
      };
      await audio.play();
      if (myGen !== ttsGenRef.current) { audio.pause(); return; }
      setTtsPlaying(turnIndex);
      setTtsLoading(null);
    } catch (e: any) {
      if (myGen !== ttsGenRef.current) return;
      console.error("TTS error:", e);
      setTtsLoading(null);
      drainQueue();
    }
  };

  const drainQueue = () => {
    if (!ttsAutoPlayRef.current) return;
    if (audioRef.current) return;  // something is playing
    const next = ttsQueueRef.current.shift();
    if (next) playTTS(next.idx, next.entry);
  };

  // Queue for auto-play (deduped)
  const queueTTS = (turnIndex: number, entry?: any) => {
    prefetchTTS(turnIndex, entry);
    if (!ttsAutoPlayRef.current) return;
    if (ttsQueueRef.current.some(q => q.idx === turnIndex)) return;
    ttsQueueRef.current.push({ idx: turnIndex, entry });
    if (!audioRef.current) drainQueue();
  };

  // Play from this message through the end
  const playFromHere = (startIndex: number) => {
    stopAllAudio();
    ttsQueueRef.current = [];
    setTtsAutoPlay(true);
    ttsAutoPlayRef.current = true;
    const t = transcriptRef.current;
    for (let j = startIndex; j < t.length; j++) {
      const e = t[j];
      if (e && e.message && !(e as any).isReaction && !(e as any).isStageDirection) {
        ttsQueueRef.current.push({ idx: j, entry: e });
      }
    }
    drainQueue();
  };

  const [summaryPlaying, setSummaryPlaying] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const playSummaryTTS = async () => {
    if (summaryPlaying) { stopAllAudio(); setSummaryPlaying(false); return; }
    stopAllAudio();
    if (!debateSummary) return;
    const did = debateIdRef.current || debateId;
    if (!did) return;
    const myGen = ttsGenRef.current;
    setSummaryLoading(true);
    try {
      // Trim summary to ~2000 chars to avoid Edge TTS timeout on very long text
      const text = debateSummary.length > 2000 ? debateSummary.slice(0, 2000) + "..." : debateSummary;
      const res = await fetch(`${API}/debates/${did}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, character_name: "Boru", emotion: "neutral", is_orchestrator: true }),
      });
      if (myGen !== ttsGenRef.current) return;
      if (!res.ok) throw new Error(`Summary TTS ${res.status}`);
      const blob = await res.blob();
      if (myGen !== ttsGenRef.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setSummaryPlaying(false); audioRef.current = null; };
      audio.onerror = () => { setSummaryPlaying(false); setSummaryLoading(false); audioRef.current = null; };
      await audio.play();
      if (myGen !== ttsGenRef.current) { audio.pause(); return; }
      setSummaryPlaying(true);
    } catch (e: any) {
      if (myGen !== ttsGenRef.current) return;
      console.error("Summary TTS error:", e);
    }
    setSummaryLoading(false);
  };

  const [regenerating, setRegenerating] = useState(false);
  const regenerateSummary = async () => {
    const did = debateIdRef.current || debateId;
    if (!did || regenerating) return;
    setRegenerating(true);
    setStreamingSummary("");
    setDebateSummary("");
    try {
      const res = await fetch(`${API}/debates/${did}/summary/regenerate`, { method: "POST" });
      if (!res.ok || !res.body) throw new Error(`Regenerate failed ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || "";
        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          let ev = "", data = "";
          for (const l of lines) {
            if (l.startsWith("event: ")) ev = l.slice(7).trim();
            else if (l.startsWith("data: ")) data = l.slice(6);
          }
          if (!ev) continue;
          try {
            const payload = JSON.parse(data || "{}");
            if (ev === "summary_token") { acc += payload.text || ""; setStreamingSummary(acc); }
            else if (ev === "summary_end") { setDebateSummary(payload.debate_summary || acc); setStreamingSummary(""); }
            else if (ev === "error") { console.error("Summary regen error:", payload.message); }
          } catch {}
        }
      }
    } catch (e) {
      console.error("Summary regenerate failed:", e);
    } finally {
      setRegenerating(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      ttsGenRef.current++;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      ttsAutoPlayRef.current = false;
      ttsQueueRef.current = [];
      ttsCacheRef.current.forEach(url => URL.revokeObjectURL(url));
      ttsCacheRef.current.clear();
    };
  }, []);

  // Interaction graph (SVG + D3)
  const graphSvgRef         = useRef<SVGSVGElement>(null);
  const graphWrapperRef     = useRef<HTMLDivElement>(null);
  const graphNodesRef       = useRef<GraphNode[]>([]);
  const graphEdgesRef       = useRef<GraphEdge[]>([]);
  const activeNodeRef       = useRef<string | null>(null);
  const d3SimRef            = useRef<d3.Simulation<GraphNode, any> | null>(null);
  // Graph focus: click a node → spotlight its outgoing edges
  const focusedNodeIdRef    = useRef<string | null>(null);
  const [graphStats, setGraphStats] = useState<{id: string; color: string; speeches: number}[]>([]);
  const [ledgerState, setLedgerState] = useState<{
    open_questions: any[]; resolved_questions: any[]; claims: any[];
    positions: Record<string, string>; progress: string; phase: string;
    progress_history: { round: number; phase: string; note: string }[];
  }>({ open_questions: [], resolved_questions: [], claims: [], positions: {}, progress: "", phase: "", progress_history: [] });
  const [graphHover, setGraphHover] = useState<{ x: number; y: number; source: string; target: string; count: number; questions: number; snippet: string } | null>(null);
  const transcriptRef = useRef<DebateEntry[]>([]);
  const streamingSummaryRef = useRef("");
  const esRef = useRef<EventSource | null>(null);

  // Close EventSource on unmount to prevent connection leak
  useEffect(() => {
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    fetch(`${API}/stories/${id}`)
      .then((r) => r.json())
      .then((d) => { if (d?.title) setStoryTitle(d.title); })
      .catch(() => {});
    fetch(`${API}/stories/${id}/divergence-points`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setSuggestions(d))
      .catch(() => {});
    fetch(`${API}/stories/${id}/characters`)
      .then((r) => r.json())
      .then((d: {name:string;role?:string;importance:number}[]) => {
        if (!Array.isArray(d)) return;
        const core = d;
        setStoryCharacters(core);
        // Default: all characters selected — every character has a voice
        setSelectedCharacters(new Set(core.map((c: {name:string}) => c.name)));
        // Default exploration 10% for all
        const defaults: Record<string,number> = {};
        core.forEach((c: {name:string}) => { defaults[c.name] = 10; });
        setExplorationRates(defaults);
      })
      .catch(() => {});
  }, [id]);

  // Replay mode: load a past debate by ?replay=<debateId>
  useEffect(() => {
    const replayId = searchParams.get("replay");
    if (!replayId) return;
    setStatus("starting");
    fetch(`${API}/debates/${replayId}`)
      .then(r => r.json())
      .then(d => {
        if (!d || !d.transcript) return;
        setDebateId(d.id);
        debateIdRef.current = d.id;
        setDivergence(d.divergence_description || "");
        setActiveCharacters(d.participating_characters || []);
        setAlternateEnding(d.alternate_ending || "");
        setDebateSummary(d.debate_summary || "");
        setAlternateTimeline(d.alternate_timeline || []);
        if (d.debate_summary) {
          // Don't auto-show conclusion — let user see the debate first
        }
        // Replay transcript entries into state one by one to trigger graph building
        const entries: DebateEntry[] = [];
        for (const entry of d.transcript) {
          entries.push({
            character: entry.character,
            message: entry.message,
            round: entry.round || 0,
            target_characters: entry.target_characters || entry.targets || (entry.target_character ? [entry.target_character] : undefined) || (entry.target ? [entry.target] : undefined),
            target: entry.target || entry.target_character || undefined,
            emotion: entry.emotion || "neutral",
            isObserver: entry.isObserver,
            observerEra: entry.observerEra || entry.era,
            ...(entry.isOrchestrator ? { isOrchestrator: true, orchestratorEvent: entry.orchestratorEvent } : {}),
            ...(entry.isReaction ? { isReaction: true } : {}),
            ...(entry.isStageDirection ? { isStageDirection: true } : {}),
            ...(entry.isAudience ? { isAudience: true } : {}),
          } as any);
        }
        setTranscript(entries);
        setStatus("done");
      })
      .catch(() => setStatus("idle"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    transcriptRef.current = transcript;
    streamingSummaryRef.current = streamingSummary;
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript, streaming]);

  // Resizable split drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(25, Math.min(75, pct)));
    };
    const onUp = () => { isDraggingRef.current = false; setIsDraggingSplit(false); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  const colorOf = (name: string) => CHAR_COLORS[activeCharacters.indexOf(name) % CHAR_COLORS.length] || CHAR_COLORS[0];
  const initials = (name: string) => name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

  // Track how many transcript entries the graph has already processed
  const graphProcessedRef = useRef(0);

  // Sync transcript → graph nodes + edges
  useEffect(() => {
    if (transcript.length === 0) return;
    const svgEl = graphSvgRef.current;
    const container = svgEl?.parentElement;
    const W = container?.clientWidth || 400, H = container?.clientHeight || 500;

    const ROLE_SHAPES: Record<string, string> = { protagonist: "circle", antagonist: "diamond", supporting: "square", neutral: "circle" };
    const ensureNode = (name: string) => {
      let node = graphNodesRef.current.find(n => n.id === name);
      if (!node) {
        const idx = activeCharacters.indexOf(name);
        const hex = (CHAR_COLORS[idx % CHAR_COLORS.length] || CHAR_COLORS[0]).hex;
        const charData = storyCharacters.find(c => c.name === name);
        const role = charData?.role || "neutral";
        // Arrange initially in a circle
        const total = activeCharacters.length || 1;
        const angle = (activeCharacters.indexOf(name) / total) * 2 * Math.PI;
        const dist = Math.min(W, H) * 0.3;
        node = {
          id: name,
          x: W / 2 + Math.cos(angle) * dist + (Math.random() - 0.5) * 30,
          y: H / 2 + Math.sin(angle) * dist + (Math.random() - 0.5) * 30,
          vx: 0, vy: 0, r: 18, color: hex, speeches: 0,
          role, shape: ROLE_SHAPES[role] || "circle",
        };
        graphNodesRef.current.push(node);
      }
      return node;
    };

    // Ensure Boru exists as center node (created once)
    if (!graphNodesRef.current.find(n => n.id === "Boru")) {
      graphNodesRef.current.push({
        id: "Boru", x: W / 2, y: H / 2, vx: 0, vy: 0,
        r: 26, color: "#c07820", speeches: 0,
        role: "speaker", shape: "circle",
      });
    }

    // Process all unprocessed entries (supports both live streaming and bulk replay)
    const startIdx = graphProcessedRef.current;
    const entriesToProcess = transcript.slice(startIdx);
    if (entriesToProcess.length === 0) return;

    for (let ei = 0; ei < entriesToProcess.length; ei++) {
      const last = entriesToProcess[ei];
      const globalIdx = startIdx + ei;

      // Skip non-content entries (reactions, stage directions)
      if ((last as any).isReaction || (last as any).isStageDirection) continue;

      // World observers get a node + edge to their target
      if ((last as any).isObserver) {
        const obsNode = ensureNode(last.character);
        obsNode.speeches++;
        obsNode.r = Math.min(14 + obsNode.speeches * 0.5, 18);
        obsNode.shape = "square";
        obsNode.color = "#64748b";
        const primaryTarget = last.target && last.target !== last.character ? last.target : "Boru";
        ensureNode(primaryTarget);
        const existing = graphEdgesRef.current.find(e => e.sourceId === last.character && e.targetId === primaryTarget);
        if (existing) { existing.count++; if (primaryTarget !== "Boru") existing.questions++; }
        else { graphEdgesRef.current.push({ source: last.character, target: primaryTarget, sourceId: last.character, targetId: primaryTarget, count: 1, questions: primaryTarget !== "Boru" ? 1 : 0 }); }
        continue;
      }

      // Boru's messages: count speeches + create edge to target character(s)
      if ((last as any).isOrchestrator) {
        const boruNode = graphNodesRef.current.find(n => n.id === "Boru");
        if (boruNode) {
          boruNode.speeches++;
          boruNode.r = Math.min(26 + boruNode.speeches * 0.3, 34);
        }
        const allTargets: string[] = [];
        // Prefer target_characters (array) — avoids phantom "A,B" nodes when
        // backend used to emit target: f"{a},{b}". Fall back to `targets` then `target`.
        if ((last as any).target_characters && Array.isArray((last as any).target_characters)) {
          allTargets.push(...((last as any).target_characters as string[]).filter(t => t !== "Boru" && t !== "all"));
        } else if ((last as any).targets && Array.isArray((last as any).targets)) {
          allTargets.push(...(last as any).targets);
        } else if (last.target && last.target !== "Boru" && last.target !== "all") {
          allTargets.push(last.target);
        }
        for (const t of allTargets) {
          ensureNode(t);
          const existing = graphEdgesRef.current.find(e => e.sourceId === "Boru" && e.targetId === t);
          if (existing) { existing.count++; }
          else { graphEdgesRef.current.push({ source: "Boru", target: t, sourceId: "Boru", targetId: t, count: 1, questions: 0 }); }
        }
        continue;
      }

      // Character dialogue
      const isAudience = (last as any).isAudience;
      const lastNode = ensureNode(last.character);
      if (!isAudience) {
        lastNode.speeches++;
        lastNode.r = Math.min(18 + lastNode.speeches * 1.5, 34);
      } else {
        lastNode.r = 12;
      }

      // Edges: who is this character responding to / questioning?
      // target_characters is an array — create an edge for EACH target
      let allTargets: string[] = [];
      if (last.target_characters && last.target_characters.length > 0) {
        allTargets = last.target_characters.filter(t => t !== last.character && t !== "all");
      } else if (last.target && last.target !== "all") {
        allTargets = [last.target];
      }
      // Fallback: find previous real character speaker
      if (allTargets.length === 0) {
        for (let j = globalIdx - 1; j >= Math.max(0, globalIdx - 4); j--) {
          const prev = transcript[j];
          if ((prev as any).isReaction || (prev as any).isStageDirection) continue;
          if ((prev as any).isOrchestrator) continue;
          if (!(prev as any).isObserver && !(prev as any).isAudience && prev.character !== last.character) {
            allTargets = [prev.character];
            break;
          }
        }
        if (allTargets.length === 0) allTargets = ["Boru"];
      }
      const act = classifySpeechAct(
        last.message,
        (last.target_characters as string[] | undefined) ?? (last.target ? [last.target] : []),
      );
      const isQuestion = act === "question";
      for (const targetName of allTargets) {
        ensureNode(targetName);
        const existing = graphEdgesRef.current.find(e => e.sourceId === last.character && e.targetId === targetName);
        if (existing) {
          existing.count++;
          if (isQuestion) existing.questions++;
        } else {
          graphEdgesRef.current.push({
            source: last.character, target: targetName,
            sourceId: last.character, targetId: targetName,
            count: 1, questions: isQuestion ? 1 : 0,
            speech_act: act,
          });
        }
      }
    }

    graphProcessedRef.current = transcript.length;
    activeNodeRef.current = null;

    // Update D3 simulation + stats
    setGraphStats(graphNodesRef.current.map(n => ({ id: n.id, color: n.color, speeches: n.speeches })));
    if (d3SimRef.current && (d3SimRef.current as any).update) {
      (d3SimRef.current as any).update();
    }
  }, [transcript, activeCharacters, storyCharacters]);

  // Track streaming speaker
  useEffect(() => {
    activeNodeRef.current = streaming?.character ?? null;
  }, [streaming]);

  // Graph — D3 force simulation + SVG rendering (MiroFish approach)
  useEffect(() => {
    if (status !== "running" && status !== "done") return;
    const svgEl = graphSvgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    const container = svgEl.parentElement!;
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;
    svg.attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();

    // Defs — arrow markers
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "node-shadow").attr("x", "-30%").attr("y", "-30%").attr("width", "160%").attr("height", "160%");
    filter.append("feDropShadow").attr("dx", 0).attr("dy", 1).attr("stdDeviation", 2).attr("flood-color", "#00000018");

    // Zoom + pan
    const g = svg.append("g");
    svg.call(d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on("zoom", (event) => g.attr("transform", event.transform)));

    // Shape path helper
    const nodePath = (shape: string, r: number): string => {
      if (shape === "diamond") { const s = r * 1.3; return `M0,${-s} L${s},0 L0,${s} L${-s},0 Z`; }
      if (shape === "square") { const s = r * 0.95; return `M${-s},${-s} L${s},${-s} L${s},${s} L${-s},${s} Z`; }
      return `M${-r},0 A${r},${r} 0 1,1 ${r},0 A${r},${r} 0 1,1 ${-r},0 Z`;
    };

    // Create groups
    const linkGroup = g.append("g").attr("class", "links");
    const nodeGroup = g.append("g").attr("class", "nodes");

    // Build safe edges for D3
    const safeEdges = () => {
      const nodeIds = new Set(graphNodesRef.current.map(n => n.id));
      return graphEdgesRef.current
        .filter(e => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId))
        .map(e => ({ source: e.sourceId, target: e.targetId, sourceId: e.sourceId, targetId: e.targetId, count: e.count, questions: e.questions }));
    };

    // D3 simulation — Boru at center, characters orbit around
    const simulation = d3.forceSimulation<GraphNode>(graphNodesRef.current)
      .force("charge", d3.forceManyBody<GraphNode>().strength((d: GraphNode) => -350 - d.r * 15).distanceMax(500))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide<GraphNode>().radius((d: GraphNode) => d.r + 40).strength(0.9).iterations(3))
      // Boru gets pulled strongly to center, others orbit around
      .force("x", d3.forceX<GraphNode>(W / 2).strength((d: GraphNode) => d.id === "Boru" ? 0.3 : 0.02))
      .force("y", d3.forceY<GraphNode>(H / 2).strength((d: GraphNode) => d.id === "Boru" ? 0.3 : 0.02))
      // Radial force pushes non-Boru characters outward into a ring
      .force("radial", d3.forceRadial<GraphNode>(
        Math.min(W, H) * 0.3, W / 2, H / 2
      ).strength((d: GraphNode) => d.id === "Boru" ? 0 : 0.06))
      .force("link", d3.forceLink<GraphNode, any>(safeEdges())
        .id((d: any) => d.id)
        .distance(180)
        .strength((d: any) => Math.min(0.3, 0.08 + (d.count || 1) * 0.02)))
      .velocityDecay(0.4)
      .alphaDecay(0.012)
      .on("tick", render);

    d3SimRef.current = simulation;

    function render() {
      const nodes = graphNodesRef.current;
      const edges = graphEdgesRef.current;
      const activeId = activeNodeRef.current;

      // ── Edges (enter/update/exit) ──
      const edgeData = edges.filter(e => {
        const s = nodes.find(n => n.id === e.sourceId);
        const t = nodes.find(n => n.id === e.targetId);
        return s && t && isFinite(s.x) && isFinite(t.x);
      });

      const links = linkGroup.selectAll<SVGGElement, GraphEdge>("g.edge")
        .data(edgeData, (d: GraphEdge) => `${d.sourceId}->${d.targetId}`);

      const linksEnter = links.enter().append("g").attr("class", "edge");
      linksEnter.append("path")
        .attr("fill", "none")
        .attr("stroke-linecap", "round");
      linksEnter.append("polygon").attr("class", "arrow");
      linksEnter.append("text")
        .attr("font-size", 9)
        .attr("font-weight", "bold")
        .attr("text-anchor", "middle")
        .attr("dy", 3)
        .style("pointer-events", "none");

      links.exit().remove();

      const allLinks = linkGroup.selectAll<SVGGElement, GraphEdge>("g.edge");

      allLinks.each(function(e: GraphEdge) {
        const src = nodes.find(n => n.id === e.sourceId);
        const tgt = nodes.find(n => n.id === e.targetId);
        if (!src || !tgt) return;

        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const ux = dx/d, uy = dy/d;
        const px = -uy, py = ux;
        const hasMirror = edges.some(e2 => e2.sourceId === e.targetId && e2.targetId === e.sourceId);
        const baseCurve = hasMirror ? 35 : 20;

        const isQ = e.questions > 0;
        const hasResponses = e.count > e.questions;
        const isBoruEdge = e.targetId === "Boru" || e.sourceId === "Boru";
        // Color by source character regardless of whether the edge touches Boru.
        // Boru edges remain distinctively STYLED (thicker + solid).
        const col = src.color;
        const strandCount = Math.min(e.count, 8);

        const el = d3.select(this);

        // Build strands — response strands are solid, question strands are dotted
        let pathsData = "";
        const mirrorOff = hasMirror ? 4 : 0;
        const responseCount = Math.min(e.count - e.questions, 6);
        const questionCount = Math.min(e.questions, 4);

        // Draw response strands (solid)
        for (let si = 0; si < responseCount; si++) {
          const curveMult = baseCurve + si * 12;
          const sxi = src.x + ux * (src.r + 2) + px * mirrorOff;
          const syi = src.y + uy * (src.r + 2) + py * mirrorOff;
          const txi = tgt.x - ux * (tgt.r + 6) + px * mirrorOff;
          const tyi = tgt.y - uy * (tgt.r + 6) + py * mirrorOff;
          const cpXi = (src.x + tgt.x) / 2 + px * curveMult;
          const cpYi = (src.y + tgt.y) / 2 + py * curveMult;
          pathsData += `M${sxi},${syi} Q${cpXi},${cpYi} ${txi},${tyi} `;
        }

        const focused = focusedNodeIdRef.current;
        const focusAlpha = focused ? (e.sourceId === focused ? 1 : 0.3) : 1;

        el.select("path")
          .attr("d", pathsData.trim() || `M${src.x},${src.y} L${tgt.x},${tgt.y}`)
          .attr("stroke", col)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "none")
          .attr("opacity", (isBoruEdge
            ? Math.min(0.6 + responseCount * 0.05, 0.9)
            : (hasResponses ? Math.min(0.35 + responseCount * 0.06, 0.75) : 0)) * focusAlpha);

        // Draw question strands (dotted, slightly offset)
        if (questionCount > 0) {
          let qPathsData = "";
          const qOffset = mirrorOff + (hasResponses ? 6 : 0);
          for (let qi = 0; qi < questionCount; qi++) {
            const curveMult = baseCurve + (responseCount + qi) * 12 + 8;
            const sxi = src.x + ux * (src.r + 2) + px * qOffset;
            const syi = src.y + uy * (src.r + 2) + py * qOffset;
            const txi = tgt.x - ux * (tgt.r + 6) + px * qOffset;
            const tyi = tgt.y - uy * (tgt.r + 6) + py * qOffset;
            const cpXi = (src.x + tgt.x) / 2 + px * curveMult;
            const cpYi = (src.y + tgt.y) / 2 + py * curveMult;
            qPathsData += `M${sxi},${syi} Q${cpXi},${cpYi} ${txi},${tyi} `;
          }
          // Use a second path element for dotted question lines
          let qPath: any = el.select("path.q-strand");
          if (qPath.empty()) {
            qPath = el.append("path").attr("class", "q-strand").attr("fill", "none");
          }
          qPath
            .attr("d", qPathsData.trim())
            .attr("stroke", col)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", isBoruEdge ? "none" : "4,3")
            .attr("opacity", Math.min(0.4 + questionCount * 0.1, 0.8) * focusAlpha);
        } else {
          el.select("path.q-strand").remove();
        }

        // Arrowhead on the central strand
        const sx0 = src.x + ux * (src.r + 2) + px * (hasMirror ? 4 : 0);
        const sy0 = src.y + uy * (src.r + 2) + py * (hasMirror ? 4 : 0);
        const tx0 = tgt.x - ux * (tgt.r + 6) + px * (hasMirror ? 4 : 0);
        const ty0 = tgt.y - uy * (tgt.r + 6) + py * (hasMirror ? 4 : 0);
        const cpX0 = (src.x + tgt.x) / 2 + px * baseCurve;
        const cpY0 = (src.y + tgt.y) / 2 + py * baseCurve;
        const t2 = 0.92;
        const bx = (1-t2)*(1-t2)*sx0 + 2*(1-t2)*t2*cpX0 + t2*t2*tx0;
        const by = (1-t2)*(1-t2)*sy0 + 2*(1-t2)*t2*cpY0 + t2*t2*ty0;
        const adx = tx0 - bx, ady = ty0 - by;
        const ad = Math.sqrt(adx*adx + ady*ady) || 1;
        const aSize = 8;
        const aUx = adx/ad, aUy = ady/ad;
        const a1x = tx0 - aUx*aSize - aUy*(aSize*0.6);
        const a1y = ty0 - aUy*aSize + aUx*(aSize*0.6);
        const a2x = tx0 - aUx*aSize + aUy*(aSize*0.6);
        const a2y = ty0 - aUy*aSize - aUx*(aSize*0.6);
        el.select("polygon.arrow")
          .attr("points", `${tx0},${ty0} ${a1x},${a1y} ${a2x},${a2y}`)
          .attr("fill", col)
          .attr("opacity", (isBoruEdge ? 0.95 : 0.7) * focusAlpha);

        // Label
        const labelX = 0.25 * sx0 + 0.5 * cpX0 + 0.25 * tx0;
        const labelY = 0.25 * sy0 + 0.5 * cpY0 + 0.25 * ty0;
        const labelText = isQ ? (e.questions === 1 ? "?" : `${e.questions}?`) : (e.count > 1 ? `${e.count}×` : "");
        el.select("text")
          .attr("x", labelX).attr("y", labelY)
          .attr("fill", col)
          .text(labelText);
      });

      // ── Nodes (enter/update/exit) ──
      const nodeData = nodes.filter(n => isFinite(n.x) && isFinite(n.y));
      const nodesSel = nodeGroup.selectAll<SVGGElement, GraphNode>("g.node")
        .data(nodeData, (d: GraphNode) => d.id);

      const nodesEnter = nodesSel.enter().append("g").attr("class", "node")
        .attr("filter", "url(#node-shadow)")
        .style("cursor", "pointer")
        .on("click", (event, d) => {
          event.stopPropagation();
          const cur = focusedNodeIdRef.current;
          focusedNodeIdRef.current = cur === d.id ? null : d.id;
          render();
        })
        .call(d3.drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          }));

      nodesEnter.append("path").attr("class", "shape");
      nodesEnter.append("text").attr("class", "initials")
        .attr("text-anchor", "middle").attr("dominant-baseline", "central")
        .attr("fill", "white").attr("font-weight", "bold")
        .style("pointer-events", "none");
      nodesEnter.append("text").attr("class", "label")
        .attr("text-anchor", "middle")
        .attr("fill", "#6b5c4e").attr("font-weight", "600")
        .style("pointer-events", "none");
      // Speaking ring (hidden by default)
      nodesEnter.append("circle").attr("class", "speaking-ring")
        .attr("fill", "none").attr("stroke-width", 2).attr("opacity", 0);
      // Speech count badge
      nodesEnter.append("circle").attr("class", "badge-bg").attr("r", 7).attr("fill", "white").attr("stroke-width", 1.2);
      nodesEnter.append("text").attr("class", "badge-text")
        .attr("text-anchor", "middle").attr("dominant-baseline", "central")
        .attr("font-size", 7).attr("font-weight", "bold")
        .style("pointer-events", "none");

      nodesSel.exit().remove();

      const allNodes = nodeGroup.selectAll<SVGGElement, GraphNode>("g.node");

      allNodes.attr("transform", (d: GraphNode) => `translate(${d.x},${d.y})`);

      allNodes.each(function(d: GraphNode) {
        const el = d3.select(this);
        const isActive = d.id === activeId;

        el.select("path.shape")
          .attr("d", nodePath(d.shape, d.r))
          .attr("fill", d.color)
          .attr("stroke", isActive ? d.color : "#fff")
          .attr("stroke-width", isActive ? 3.5 : 2.5)
          .attr("opacity", 0.9);

        const fontSize = Math.max(10, Math.min(13, d.r * 0.65));
        el.select("text.initials")
          .attr("font-size", fontSize)
          .text(d.id.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase());

        el.select("text.label")
          .attr("y", d.r + 14)
          .attr("font-size", Math.max(9, Math.min(11, d.r * 0.5)))
          .attr("fill", isActive ? "#3d2f20" : "#8a7260")
          .text(d.id.split(" ").slice(0, 2).join(" "));

        // Speaking ring animation
        el.select("circle.speaking-ring")
          .attr("r", d.r + 6)
          .attr("stroke", d.color)
          .attr("opacity", isActive ? 0.6 : 0);

        // Badge
        const bx = d.r * 0.7, by = -d.r * 0.7;
        el.select("circle.badge-bg")
          .attr("cx", bx).attr("cy", by)
          .attr("stroke", d.color + "88")
          .attr("opacity", d.speeches > 0 ? 1 : 0);
        el.select("text.badge-text")
          .attr("x", bx).attr("y", by)
          .attr("fill", d.color)
          .text(d.speeches > 0 ? String(d.speeches) : "");
      });
    }

    // Update simulation when nodes/edges change (called from transcript sync effect)
    const updateSim = () => {
      simulation.nodes(graphNodesRef.current);
      const linkForce = simulation.force("link") as d3.ForceLink<GraphNode, any>;
      if (linkForce) linkForce.links(safeEdges());
      simulation.alpha(0.3).restart();
    };
    // Expose updater on the ref so transcript sync can call it
    (d3SimRef as any).current = { sim: simulation, update: updateSim };

    // Resize handler
    const onResize = () => {
      const nW = container.clientWidth || 600;
      const nH = container.clientHeight || 400;
      svg.attr("viewBox", `0 0 ${nW} ${nH}`);
      simulation.force("center", d3.forceCenter(nW / 2, nH / 2));
      simulation.force("x", d3.forceX<GraphNode>(nW / 2).strength(0.035));
      simulation.force("y", d3.forceY<GraphNode>(nH / 2).strength(0.035));
      simulation.alpha(0.1).restart();
    };
    window.addEventListener("resize", onResize);

    // Click on empty SVG background clears node focus
    svg.on("click", () => {
      if (focusedNodeIdRef.current) {
        focusedNodeIdRef.current = null;
        render();
      }
    });

    // Tooltip on edge hover
    svg.on("mousemove", (event: MouseEvent) => {
      // Skip tooltip during drag
      const [mx, my] = d3.pointer(event, g.node());
      const nodes = graphNodesRef.current;
      const edges = graphEdgesRef.current;
      // Check if hovering a node — no tooltip
      if (nodes.some(n => Math.sqrt((n.x - mx)**2 + (n.y - my)**2) <= n.r + 6)) { setGraphHover(null); return; }
      for (const edge of edges) {
        const src = nodes.find(n => n.id === edge.sourceId);
        const tgt = nodes.find(n => n.id === edge.targetId);
        if (!src || !tgt || !isFinite(src.x) || !isFinite(tgt.x)) continue;
        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1;
        const px = -(tgt.y - src.y)/dist, py = (tgt.x - src.x)/dist;
        const hasMirror = edges.some(e2 => e2.sourceId === edge.targetId && e2.targetId === edge.sourceId);
        const curve = hasMirror ? 35 : 20;
        const cpX = (src.x + tgt.x)/2 + px*curve, cpY = (src.y + tgt.y)/2 + py*curve;
        let minD = Infinity;
        for (let t = 0; t <= 1; t += 1/12) {
          const bx = (1-t)*(1-t)*src.x + 2*(1-t)*t*cpX + t*t*tgt.x;
          const by = (1-t)*(1-t)*src.y + 2*(1-t)*t*cpY + t*t*tgt.y;
          minD = Math.min(minD, Math.sqrt((mx-bx)**2 + (my-by)**2));
        }
        if (minD < 14) {
          const msgs = transcriptRef.current.filter(e => e.character === edge.sourceId && e.target === edge.targetId);
          const last = msgs[msgs.length - 1];
          const snippet = last ? last.message.slice(0, 120).trimEnd() + (last.message.length > 120 ? "…" : "") : "";
          setGraphHover({ x: event.offsetX, y: event.offsetY, source: edge.sourceId, target: edge.targetId, count: edge.count, questions: edge.questions, snippet });
          return;
        }
      }
      setGraphHover(null);
    });
    svg.on("mouseleave", () => setGraphHover(null));

    return () => {
      simulation.stop();
      d3SimRef.current = null;
      window.removeEventListener("resize", onResize);
    };
  }, [status]);



  const startDebate = async () => {
    if (!divergence.trim()) return;
    setStatus("starting");
    graphNodesRef.current = [];
    graphEdgesRef.current = [];
    if (d3SimRef.current && (d3SimRef.current as any).sim) {
      (d3SimRef.current as any).sim.stop();
    }
    const res = await fetch(`${API}/debates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        story_id: id,
        divergence_description: divergence,
        character_names: selectedCharacters.size > 0 ? Array.from(selectedCharacters) : undefined,
        character_exploration: Object.fromEntries(
          Object.entries(explorationRates).map(([k, v]) => [k, v / 100])
        ),
      }),
    });
    const data = await res.json();
    setDebateId(data.debate_id);
    debateIdRef.current = data.debate_id;
    setActiveCharacters(data.characters);
    setStatus("running");

    const es = new EventSource(`${API}/debates/${data.debate_id}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "exploration") {
        pendingExplorationRef.current = ev.character;
      } else if (ev.type === "character_start") {
        setStreaming({ character: ev.character, text: "" });
        setDramaScore(ev.drama_score || 0.5);
      } else if (ev.type === "token") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + ev.text } : null);
      } else if (ev.type === "continuation_granted") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + "\n\n" } : null);
      } else if (ev.type === "character_end") {
        const isExploration = pendingExplorationRef.current === ev.character;
        if (isExploration) pendingExplorationRef.current = null;
        // Clear any pending observer challenge for this character
        setPendingChallenge(prev => prev?.character === ev.character ? null : prev);
        const newEntry = {
          character: ev.character,
          message: ev.message,
          round: ev.round || 0,
          target_characters: ev.target_characters || (ev.target_character ? [ev.target_character] : undefined) || (ev.target ? [ev.target] : undefined),
          target: ev.target || (ev.target_character ? ev.target_character : undefined),
          emotion: ev.emotion || "neutral",
          judgeScore: typeof ev.judge_score === "number" ? ev.judge_score : undefined,
          isExploration,
        };
        setTranscript(prev => {
          const idx = prev.length;
          queueTTS(idx, newEntry);
          return [...prev, newEntry];
        });
        setStreaming(null);
      } else if (ev.type === "ledger_update") {
        setLedgerState({
          open_questions: ev.open_questions || [],
          resolved_questions: ev.resolved_questions || [],
          claims: ev.claims || [],
          positions: ev.positions || {},
          progress: ev.progress || "",
          phase: ev.phase || "",
          progress_history: ev.progress_history || [],
        });
      } else if (ev.type === "reactions") {
        // Emotional reactions from other characters
        for (const r of (ev.reactions || [])) {
          setTranscript(prev => [...prev, {
            character: r.character,
            message: r.reaction,
            round: 0,
            isReaction: true,
          }]);
        }
      } else if (ev.type === "stage_direction") {
        setTranscript(prev => [...prev, {
          character: "Narrator",
          message: ev.text,
          round: 0,
          isStageDirection: true,
        }]);
      } else if (ev.type === "audience") {
        // Audience member's message appears in transcript
        setTranscript(prev => [...prev, {
          character: ev.name,
          message: ev.message,
          round: 0,
          isAudience: true,
        }]);
      } else if (ev.type === "orchestrator") {
        // Boru the Elephant speaks
        const boruEntry = {
          character: "Boru",
          message: ev.message,
          round: 0,
          target: ev.target || undefined,
          targets: ev.targets || undefined,
          target_characters: ev.target_characters || undefined,
          isOrchestrator: true,
          orchestratorEvent: ev.event,
          phase: ev.phase,
        };
        setTranscript(prev => {
          const idx = prev.length;
          queueTTS(idx, boruEntry);
          return [...prev, boruEntry];
        });
      } else if (ev.type === "summary_token") {
        setStreamingSummary(prev => prev + ev.text);
      } else if (ev.type === "summary_start") {
        setStreamingSummary("");
      } else if (ev.type === "synthesis_start") {
        // Summary is done, save it and start ending
        setDebateSummary(prev => prev || streamingSummaryRef.current);
        setStreamingSummary("");
      } else if (ev.type === "ending_token") {
        setStreamingEnding(prev => prev + ev.text);
      } else if (ev.type === "debate_end") {
        setAlternateEnding(ev.alternate_ending);
        setDebateSummary(ev.debate_summary || streamingSummaryRef.current || "");
        setAlternateTimeline(ev.alternate_timeline || []);
        setStreamingEnding("");
        setStreamingSummary("");
        setStatus("done");
        if (ev.oracle_ready) setOracleReady(true);
        setTimeout(() => setShowConclusion(true), 800);
        // Mark clean close BEFORE calling es.close() so the subsequent
        // onerror (which always fires on close) knows not to panic.
        debateClosedCleanlyRef.current = true;
        es.close();
      } else if (ev.type === "interrogator_start") {
        setStreaming({ character: "The Interrogator", text: "" });
      } else if (ev.type === "interrogator_token") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + ev.text } : null);
      } else if (ev.type === "interrogator_end") {
        const interrogatorEntry = {
          character: "The Interrogator",
          message: ev.message,
          round: 0,
          isObserver: true,
          observerEra: "structural voice",
        };
        setTranscript(prev => {
          const idx = prev.length;
          queueTTS(idx, interrogatorEntry);
          return [...prev, interrogatorEntry];
        });
        setStreaming(null);
      } else if (ev.type === "observer_challenge") {
        setPendingChallenge({ character: ev.character, observerName: ev.observer_name, question: ev.question });
      } else if (ev.type === "observer_start") {
        setStreaming({ character: ev.observer_name, text: "" });
      } else if (ev.type === "observer_token") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + ev.text } : null);
      } else if (ev.type === "observer_end") {
        const observerEntry = {
          character: ev.observer_name,
          message: ev.message,
          round: 0,
          target: ev.question_target || undefined,
          isObserver: true,
          observerEra: ev.era || "",
        };
        setTranscript(prev => {
          const idx = prev.length;
          queueTTS(idx, observerEntry);
          return [...prev, observerEntry];
        });
        setStreaming(null);
      } else if (ev.type === "turn_error") {
        // One turn failed — surface the reason inline as a system message
        // so the user can see WHY a character couldn't speak (rate limits,
        // context overflow, unavailable provider). Otherwise users see
        // the streaming bubble vanish with no explanation.
        setStreaming(null);
        const reason = ev.reason || "the model couldn't respond";
        const character = ev.character || "A character";
        setTranscript(prev => [
          ...prev,
          {
            character: "(system)",
            message: `⚠ ${character} couldn't respond: ${reason}. Continuing with the next speaker…`,
            round: prev.length,
            isStageDirection: true,
          } as any,
        ]);
      }
    };
    es.onerror = () => {
      es.close();
      setStreaming(null);
      // Only surface an "interrupted" notice if the debate had NOT cleanly
      // reached debate_end — otherwise this is just the natural close.
      if (!debateClosedCleanlyRef.current) {
        setTranscript(prev => [...prev, {
          character: "Boru",
          message: "The Sabha's connection was interrupted. The debate may have ended, or there was a network issue. You can review what was said above.",
          round: 0,
          isOrchestrator: true,
          orchestratorEvent: "error",
          phase: "interrupted",
        } as any]);
      }
      setStatus(prev => prev === "running" ? "done" : prev);
    };
  };

  const sendOracleQuestion = async () => {
    const q = oracleInput.trim();
    if (!q || oracleLoading || !debateId || !oracleCharacter) return;
    // Lock the target character at send time — if the user switches mid-stream,
    // the streamed reply still lands in the original character's history.
    const targetChar = oracleCharacter;
    const appendTo = (msg: {role:string;content:string;character?:string}) =>
      setOracleHistories(prev => ({ ...prev, [targetChar]: [...(prev[targetChar] || []), msg] }));
    const priorHistory = oracleHistories[targetChar] || [];
    setOracleInput("");
    appendTo({ role: "user", content: q });
    setOracleLoading(true);
    setOracleStreaming("");
    try {
      const res = await fetch(`${API}/debates/${debateId}/oracle/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_name: targetChar, question: q, history: priorHistory }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let full = "";
      let gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "token") { full += ev.text; setOracleStreaming(full); }
            if (ev.type === "error") { full = ev.message || "The oracle could not reach this character right now."; }
            if (ev.type === "done") {
              appendTo({ role: "assistant", content: full || "…", character: targetChar });
              setOracleStreaming("");
              gotDone = true;
            }
          } catch (e) { console.error("Failed to parse oracle SSE:", e); }
        }
      }
      // Stream closed without a done event (network cut / server error)
      if (!gotDone) {
        appendTo({ role: "assistant", content: full || "The oracle could not reach this character right now.", character: targetChar });
        setOracleStreaming("");
      }
    } catch {
      appendTo({ role: "assistant", content: "The oracle could not reach this character right now.", character: targetChar });
      setOracleStreaming("");
    } finally {
      setOracleLoading(false);
    }
  };

  const sendStoryChar = async () => {
    const q = storyCharInput.trim();
    if (!q || storyCharLoading || !oracleCharacter) return;
    setStoryCharInput("");
    setStoryCharMsgs(prev => [...prev, { role: "user", content: q }]);
    setStoryCharLoading(true);
    setStoryCharStreaming("");
    try {
      const res = await fetch(
        `${API}/stories/${id}/characters/${encodeURIComponent(oracleCharacter)}/chat/stream`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, history: storyCharMsgs }) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let full = "", gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "token") { full += ev.text; setStoryCharStreaming(full); }
            if (ev.type === "error") { full = ev.message || "Could not reach this character."; }
            if (ev.type === "done") { setStoryCharMsgs(prev => [...prev, { role: "assistant", content: full || "…" }]); setStoryCharStreaming(""); gotDone = true; }
          } catch (e) { console.error("Failed to parse char SSE:", e); }
        }
      }
      if (!gotDone) { setStoryCharMsgs(prev => [...prev, { role: "assistant", content: full || "Could not reach this character." }]); setStoryCharStreaming(""); }
    } catch (e) {
      console.error("Story char chat error:", e);
      setStoryCharMsgs(prev => [...prev, { role: "assistant", content: "Could not reach this character right now." }]);
      setStoryCharStreaming("");
    } finally { setStoryCharLoading(false); }
  };

  const sendAudienceMessage = async () => {
    const msg = audienceInput.trim();
    if (!msg || !debateId || !audienceNameSet) return;
    setAudienceInput("");
    try {
      await fetch(`${API}/debates/${debateId}/audience`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: audienceName, message: msg }),
      });
    } catch (e) { console.error("Audience message failed:", e); }
  };

  const sendDebateChat = async () => {
    const q = chatInput.trim();
    if (!q || chatLoading || !debateId) return;
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", content: q }]);
    setChatLoading(true);
    try {
      const res = await fetch(`${API}/debates/${debateId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history: chatMessages }),
      });
      const data = await res.json();
      setChatMessages(prev => [...prev, { role: "assistant", content: data.answer }]);
    } catch {
      setChatMessages(prev => [...prev, { role: "assistant", content: "Sorry, couldn't reach the orchestrator." }]);
    } finally {
      setChatLoading(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  /* ── IDLE / SETUP SCREEN ── */
  if (status === "idle" || status === "starting") {
    return (
      <main className="flex flex-col overflow-hidden bg-[#f7f3ed]" style={{ height: "calc(100vh - 56px)" }}>
        {/* Top bar */}
        <div className="shrink-0 bg-white border-b border-[#e8e0d5]">
          <div className="px-8 lg:px-12 py-3 flex items-center justify-between">
            <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors flex items-center gap-1.5">
              ← {storyTitle || "Back"}
            </Link>
            <div className="text-xs font-semibold tracking-[0.2em] text-[#c07820] uppercase">Sabha · The Great Debate</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col px-8 lg:px-12 py-10 gap-8">

          {/* Page heading */}
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold text-[#1c1410] leading-tight">
              What if things had gone <span className="ink-shimmer">differently?</span>
            </h1>
            <p className="text-[#6b5c4e]">Set the scenario, pick your cast, and let the debate begin.</p>
          </div>

          {/* Two-column body */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

            {/* ── SECTION 1: The Scenario ── */}
            <div className="flex flex-col gap-4">
              {/* Section header */}
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-[#c07820] text-white text-xs font-bold flex items-center justify-center shrink-0">1</div>
                <div>
                  <div className="text-base font-bold text-[#1c1410]">Set the Scenario</div>
                  <div className="text-xs text-[#a09282]">Describe the alternate divergence point</div>
                </div>
              </div>

              {/* Textarea card */}
              <div className={`bg-white rounded-2xl border-2 transition-colors overflow-hidden ${divergence.trim() ? "border-[#c07820]" : "border-[#e8e0d5] focus-within:border-[#c07820]"}`}>
                <div className="px-5 pt-4 pb-2">
                  <div className="text-xs font-bold text-[#c07820] uppercase tracking-widest mb-2.5">What if…</div>
                  <textarea
                    value={divergence}
                    onChange={(e) => setDivergence(e.target.value)}
                    placeholder="Boxer refused to go to the slaughterhouse and led a revolt against Napoleon…"
                    className="w-full bg-transparent resize-none h-32 text-[#1c1410] placeholder-[#c8b89a] focus:outline-none text-base leading-relaxed"
                  />
                </div>
                <div className="px-5 py-3 bg-[#faf7f2] border-t border-[#e8e0d5] flex items-center justify-between">
                  <span className="text-xs text-[#a09282]">
                    {divergence.length > 0 ? `${divergence.length} chars` : "Be specific — characters will debate this exact point"}
                  </span>
                  <button
                    onClick={startDebate}
                    disabled={!divergence.trim() || status === "starting"}
                    className="flex items-center gap-2 bg-[#c07820] hover:bg-[#a86a18] disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold px-5 py-2 rounded-xl transition-all text-sm shadow-sm"
                  >
                    {status === "starting" ? (
                      <><span className="animate-breathe">⚡</span> Starting…</>
                    ) : (
                      <><span>⚡</span> Start Sabha (Debate)</>
                    )}
                  </button>
                </div>
              </div>

              {/* Suggestions — shown below textarea as inspiration */}
              {suggestions.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-3 pb-1">
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                    <span className="text-xs text-[#c8b89a]">or pick a story suggestion</span>
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                  </div>
                  <div className="text-xs font-medium text-[#a09282] uppercase tracking-widest mb-2">Story suggests</div>
                  {suggestions.map((s, i) => {
                    const active = divergence === s.description;
                    return (
                      <button
                        key={`${s.event_id || "sugg"}-${i}`}
                        onClick={() => setDivergence(s.description)}
                        className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-150 group ${
                          active
                            ? "border-[#c07820] bg-[#fef3e2]"
                            : "border-[#e8e0d5] bg-white hover:border-[#c07820]/50 hover:bg-[#fef9f2]"
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <span className={`mt-0.5 shrink-0 text-sm font-bold transition-colors ${active ? "text-[#c07820]" : "text-[#c8b89a] group-hover:text-[#c07820]"}`}>→</span>
                          <div>
                            <p className={`text-sm leading-snug ${active ? "text-[#1c1410] font-medium" : "text-[#6b5c4e]"}`}>{s.description}</p>
                            {s.affected_characters.length > 0 && (
                              <div className="flex gap-1 mt-1.5 flex-wrap">
                                {s.affected_characters.map((c: string, ci: number) => (
                                  <span key={`${ci}-${c}`} className="text-xs px-2 py-0.5 rounded-full font-medium"
                                    style={{ background: CHAR_COLORS[ci % CHAR_COLORS.length].hex + "18", color: CHAR_COLORS[ci % CHAR_COLORS.length].hex }}>
                                    {c}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* How it works — subtle hint */}
              <div className="flex items-start gap-3 px-1">
                <div className="shrink-0 w-5 h-5 rounded-full bg-[#f0ece5] border border-[#e8e0d5] flex items-center justify-center mt-0.5">
                  <span className="text-[#a09282] text-xs">?</span>
                </div>
                <p className="text-xs text-[#a09282] leading-relaxed">
                  Characters will explore the what-if scenario, challenge each other, and imagine how the story changes. When the debate concludes, an alternate ending is written.
                </p>
              </div>
            </div>

            {/* ── SECTION 2: The Cast ── */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-[#3d2f20] text-white text-xs font-bold flex items-center justify-center shrink-0">2</div>
                <div>
                  <div className="text-base font-bold text-[#1c1410]">Assemble the Cast</div>
                  <div className="text-xs text-[#a09282]">Choose who joins the debate</div>
                </div>
              </div>

              {storyCharacters.length > 0 ? (
                <>
                  {/* Select all / clear */}
                  <div className="flex items-center gap-3 px-1">
                    <button onClick={() => setSelectedCharacters(new Set(storyCharacters.map(c => c.name)))}
                      className="text-xs font-medium text-[#c07820] hover:underline">Select all</button>
                    <span className="text-[#e8e0d5]">·</span>
                    <button onClick={() => setSelectedCharacters(new Set())}
                      className="text-xs text-[#a09282] hover:underline">Clear all</button>
                    <span className="text-xs text-[#a09282] ml-auto">
                      <span className="font-semibold text-[#6b5c4e]">{selectedCharacters.size}</span> of {storyCharacters.length} selected
                    </span>
                  </div>

                  {/* Character cards */}
                  <div className="space-y-2">
                    {storyCharacters.map((char, idx) => {
                      const rate = explorationRates[char.name] ?? 10;
                      const color = CHAR_COLORS[idx % CHAR_COLORS.length];
                      const selected = selectedCharacters.has(char.name);
                      return (
                        <div key={`${idx}-${char.name}`}
                          className={`rounded-2xl border transition-all duration-200 overflow-hidden ${
                            selected
                              ? "bg-white border-[#e8e0d5] shadow-sm"
                              : "bg-[#faf7f2] border-[#ede8e1] opacity-55"
                          }`}
                        >
                          {/* Card header row */}
                          <div
                            className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                            onClick={() => setSelectedCharacters(prev => {
                              const next = new Set(prev);
                              next.has(char.name) ? next.delete(char.name) : next.add(char.name);
                              return next;
                            })}
                          >
                            {/* Checkbox */}
                            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-all ${selected ? "border-[#c07820] bg-[#c07820]" : "border-[#c8b89a] bg-white"}`}>
                              {selected && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
                            </div>
                            {/* Avatar */}
                            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm"
                              style={{ backgroundColor: selected ? color.hex : "#c8b89a" }}>
                              {char.name.split(" ").map((w:string) => w[0]).join("").slice(0,2).toUpperCase()}
                            </div>
                            {/* Name + role */}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold text-[#1c1410] truncate">{char.name}</div>
                              {char.role && <div className="text-xs text-[#a09282] truncate">{char.role}</div>}
                            </div>
                          </div>

                          {/* Depth slider removed — exploration rate fixed at 10% internally */}
                          {false && selected && (
                            <div className="px-4 pb-3 space-y-1.5 border-t border-[#f0ece5]">
                              <div className="flex items-center gap-3 pt-2">
                                <span className="text-xs text-[#c8b89a] shrink-0">In character</span>
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  step={5}
                                  value={rate}
                                  onChange={(e) => setExplorationRates(prev => ({ ...prev, [char.name]: Number(e.target.value) }))}
                                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                                  style={{
                                    background: `linear-gradient(to right, ${color.hex} ${rate}%, #e8e0d5 ${rate}%)`,
                                    accentColor: color.hex,
                                  }}
                                />
                                <span className="text-xs text-[#c8b89a] shrink-0">Hidden depths</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center space-y-2 bg-white rounded-2xl border border-[#e8e0d5]">
                  <div className="text-3xl">⏳</div>
                  <p className="text-sm text-[#a09282]">Loading characters…</p>
                </div>
              )}
            </div>
          </div>
        </div>
        </div>{/* end flex-1 overflow-y-auto */}
      </main>
    );
  }

  /* ── DEBATE SCREEN ── */
  return (
    <main className="relative flex flex-col bg-[#f7f3ed] overflow-hidden" style={{ height: "calc(100vh - 56px)" }}>
      {/* Sub-header — fixed height, no sticky needed (main is overflow:hidden) */}
      <div className="border-b border-[#e8e0d5] bg-white shrink-0">

        {/* Breadcrumb row */}
        <div className="px-5 pt-2.5 pb-1 flex items-center gap-2">
          <Link href={`/story/${id}`}
            className="text-[#a09282] hover:text-[#1c1410] text-xs transition-colors shrink-0 flex items-center gap-1">
            ←
          </Link>
          {storyTitle && (
            <>
              <Link href={`/story/${id}`} className="text-xs text-[#a09282] hover:text-[#6b5c4e] transition-colors truncate max-w-[180px]">
                {storyTitle}
              </Link>
              <span className="text-[#e8e0d5] text-xs">/</span>
            </>
          )}
          <span className="text-xs text-[#6b5c4e] font-medium">Sabha</span>
          <div className="flex items-center gap-1.5 ml-auto shrink-0">
            {status === "running" && (
              <div className="flex items-center gap-2">
                <span className="flex gap-0.5 items-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#c07820] animate-pulse" />
                  <span className="text-xs text-[#c07820] font-semibold uppercase tracking-wide">Live</span>
                </span>
                <button
                  onClick={async () => {
                    if (debateId) {
                      await fetch(`${API}/debates/${debateId}/stop`, { method: "POST" });
                    }
                  }}
                  className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors font-medium"
                  title="End the debate early"
                >
                  Stop
                </button>
              </div>
            )}
            {status === "done" && (
              <span className="text-xs text-emerald-600 font-semibold uppercase tracking-wide flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Concluded
              </span>
            )}
          </div>
        </div>

        {/* Question row */}
        <div className="px-5 pb-1.5 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#1c1410] truncate leading-tight">
              <span className="text-[#c07820] mr-1.5 font-bold text-xs">What if…</span>
              {divergence || "—"}
            </p>
          </div>
        </div>

        {/* Stats bar */}
        {transcript.length > 0 && (() => {
          const sorted = [...graphStats].sort((a, b) => b.speeches - a.speeches);
          const total = sorted.reduce((s, n) => s + n.speeches, 0) || 1;
          return (
            <div className="px-5 pb-1.5 flex items-center gap-4">
              {[
                { label: "Turns", value: String(transcript.filter(e => !(e as any).isOrchestrator && !(e as any).isReaction && !(e as any).isStageDirection).length) },
                { label: "Speakers", value: String(activeCharacters.length) },
              ].map(s => (
                <div key={s.label} className="flex items-center gap-1.5 text-xs">
                  <span className="font-bold text-[#1c1410] text-sm">{s.value}</span>
                  <span className="text-[#a09282] uppercase tracking-wide text-[10px]">{s.label}</span>
                </div>
              ))}
              {/* Drama bar */}
              <div className="flex items-center gap-1.5 ml-1">
                <span className="text-[10px] text-[#a09282] uppercase tracking-wide">Drama</span>
                <div className="w-16 h-1.5 bg-[#e8e0d5] rounded-full overflow-hidden">
                  <div className="h-full bg-[#c07820] rounded-full transition-all duration-700" style={{ width: `${dramaScore * 100}%` }} />
                </div>
              </div>
              {/* Mini voice share */}
              {sorted.length > 0 && (
                <div className="flex items-center gap-0.5 ml-auto">
                  {sorted.slice(0, 6).map(n => (
                    <div key={n.id} title={`${n.id}: ${Math.round((n.speeches / total) * 100)}%`}
                      className="h-3 rounded-sm min-w-[4px] transition-all duration-500"
                      style={{ width: `${Math.max(4, (n.speeches / total) * 80)}px`, backgroundColor: n.color }} />
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* View tabs + avatar row */}
        <div className="px-5 pb-0 flex items-center gap-3">
          {/* Avatars */}
          <div className="flex items-center gap-0.5 shrink-0">
          {activeCharacters.length > 0 ? (
            <>
              <div className="flex items-center">
                {activeCharacters.slice(0, 14).map((name, i) => {
                  const col = CHAR_COLORS[i % CHAR_COLORS.length].hex;
                  const isActive = streaming?.character === name;
                  return (
                    <div key={name} title={name}
                      className="relative -ml-1 first:ml-0 w-5 h-5 rounded-full border-2 border-white flex items-center justify-center text-white font-bold text-[8px] transition-all duration-200"
                      style={{ backgroundColor: col, zIndex: isActive ? 20 : activeCharacters.length - i, boxShadow: isActive ? `0 0 0 2px ${col}, 0 0 6px ${col}99` : undefined }}>
                      {initials(name)}
                      {isActive && <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 border border-white animate-pulse" />}
                    </div>
                  );
                })}
                {activeCharacters.length > 14 && (
                  <div className="relative -ml-1 w-5 h-5 rounded-full border-2 border-white bg-[#e8e0d5] flex items-center justify-center text-[#6b5c4e] font-bold text-[8px]">
                    +{activeCharacters.length - 14}
                  </div>
                )}
              </div>
              {streaming && streaming.character !== "The Interrogator" && activeCharacters.includes(streaming.character) && (
                <span className="text-xs text-[#6b5c4e] ml-1">
                  <span className="font-semibold" style={{ color: CHAR_COLORS[activeCharacters.indexOf(streaming.character) % CHAR_COLORS.length]?.hex }}>
                    {streaming.character}
                  </span> is speaking…
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-[#c8b89a]">Waiting for debate to start…</span>
          )}
          </div>

          {/* Layout controls */}
          <div className="flex items-center gap-1 ml-auto shrink-0">
            <button onClick={() => setMaximize(m => m === "left" ? "none" : "left")} title="Maximize debate"
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${maximize === "left" ? "bg-[#c07820] text-white" : "text-[#a09282] hover:text-[#6b5c4e] hover:bg-[#f0ece5]"}`}>
              💬
            </button>
            <button onClick={() => setMaximize("none")} title="Split view"
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${maximize === "none" ? "bg-[#c07820] text-white" : "text-[#a09282] hover:text-[#6b5c4e] hover:bg-[#f0ece5]"}`}>
              ⊞
            </button>
            <button onClick={() => setMaximize(m => m === "right" ? "none" : "right")} title="Maximize graph"
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors ${maximize === "right" ? "bg-[#c07820] text-white" : "text-[#a09282] hover:text-[#6b5c4e] hover:bg-[#f0ece5]"}`}>
              ⬡
            </button>
          </div>
        </div>

      </div>

      {/* ── Split view ── */}
      <div ref={splitContainerRef} className="flex-1 flex overflow-hidden"
        style={{ cursor: isDraggingSplit ? "col-resize" : "auto", userSelect: isDraggingSplit ? "none" : "auto" }}>

        {/* ══ LEFT: Debate transcript ══ */}
        <div className="flex flex-col overflow-hidden"
          style={{ width: maximize === "right" ? "0px" : maximize === "left" ? "100%" : `${splitPct}%`, display: maximize === "right" ? "none" : "flex" }}>

          {/* Fixed toolbar — status + emotions + auto-play — single line */}
          <div data-print-hide="true" className="shrink-0 border-b border-[#e8e0d5] bg-white/90 px-5 py-1.5 flex items-center gap-3 min-h-[36px]">
            {/* Emotion legend toggle */}
            <button
              onClick={() => setShowLegend(v => !v)}
              className="flex items-center gap-1.5 text-[10px] text-[#a09282] hover:text-[#6b5c4e] uppercase tracking-widest font-medium transition-colors shrink-0"
            >
              <span>{showLegend ? "▾" : "▸"}</span>
              Emotions
            </button>
            {/* Status — centered, shows both writing + speaking side by side */}
            <div className="flex-1 flex items-center justify-center gap-3 min-w-0">
              {streaming && (
                <span className="flex items-center gap-1.5 text-xs truncate">
                  <span className="w-2 h-2 rounded-full animate-pulse shrink-0" style={{ backgroundColor: CHAR_COLORS[activeCharacters.indexOf(streaming.character) % CHAR_COLORS.length]?.hex || "#c07820" }} />
                  <span className="font-semibold truncate" style={{ color: CHAR_COLORS[activeCharacters.indexOf(streaming.character) % CHAR_COLORS.length]?.hex || "#c07820" }}>
                    {streaming.character}
                  </span>
                  <span className="text-[#a09282] shrink-0">writing...</span>
                </span>
              )}
              {ttsPlaying !== null && transcript[ttsPlaying] && (
                <span className="flex items-center gap-1.5 text-xs truncate">
                  <span className="w-2 h-2 rounded-full bg-[#c07820] animate-pulse shrink-0" />
                  <span className="font-semibold truncate" style={{ color: CHAR_COLORS[activeCharacters.indexOf(transcript[ttsPlaying].character) % CHAR_COLORS.length]?.hex || "#c07820" }}>
                    {transcript[ttsPlaying].character}
                  </span>
                  <span className="text-[#a09282] shrink-0">speaking 🔊</span>
                </span>
              )}
              {!streaming && ttsPlaying === null && status === "running" && (
                <span className="text-[10px] text-[#c8b89a]">waiting...</span>
              )}
            </div>
            {/* Auto-play toggle */}
            <button
              onClick={() => {
                const newVal = !ttsAutoPlay;
                setTtsAutoPlay(newVal);
                ttsAutoPlayRef.current = newVal;
                if (!newVal) { stopAllAudio(); ttsQueueRef.current = []; }
              }}
              className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors shrink-0 ${
                ttsAutoPlay
                  ? "bg-[#c07820] text-white border-[#c07820]"
                  : "text-[#6b5c4e] border-[#e8e0d5] hover:border-[#c07820] hover:text-[#c07820]"
              }`}
              title={ttsAutoPlay ? "Mute" : "Auto-play"}
            >
              {ttsAutoPlay ? "🔊 Auto-Play On" : "🔇 Auto-Play Off"}
            </button>
            {/* Export debate to PDF — sits beside auto-play */}
            <button
              onClick={async () => {
                // Ensure the graph tab is active so graphWrapperRef is rendered
                // with opacity:1 (it's opacity:0 + pointerEvents:none when inactive).
                const prevTab = rightTab;
                if (rightTab !== "graph") {
                  setRightTab("graph");
                  // Wait for re-render
                  await new Promise<void>(r => requestAnimationFrame(() => r()));
                  await new Promise<void>(r => setTimeout(r, 150));  // extra tick for D3 to settle
                }

                // Before export: force the graph wrapper to have explicit dimensions
                // so html2canvas captures it at a meaningful size.
                const gw = graphWrapperRef.current;
                console.info("[PDF] pre-export graph state:", {
                  exists: !!gw,
                  rect: gw?.getBoundingClientRect(),
                  innerHtml_preview: gw?.innerHTML.slice(0, 200),
                  childCount: gw?.childElementCount,
                  rightTab,
                  prevTab,
                });

                let undoStyle: (() => void) | null = null;
                if (gw) {
                  const rect = gw.getBoundingClientRect();
                  if (rect.width < 50 || rect.height < 50) {
                    // Force explicit size temporarily
                    const savedStyle = gw.getAttribute("style") || "";
                    gw.setAttribute(
                      "style",
                      `${savedStyle}; width: 800px; height: 600px; background: #ffffff;`,
                    );
                    undoStyle = () => gw.setAttribute("style", savedStyle);
                    // Wait a tick for the browser to relayout
                    await new Promise<void>(r => requestAnimationFrame(() => r()));
                  } else {
                    // Even with real size, add background so html2canvas doesn't capture transparent
                    gw.style.background = "#ffffff";
                  }
                }
                try {
                  await exportDebateToPdf({
                    graphElement: gw,
                    turns: transcript as any,
                    meta: {
                      storyTitle: storyTitle || "Debate",
                      divergence: divergence || "",
                      exportedAt: new Date(),
                      cast: activeCharacters.map((name, i) => ({
                        name,
                        color: CHAR_COLORS[i % CHAR_COLORS.length]?.hex,
                      })),
                      alternateEnding: alternateEnding || undefined,
                    },
                  });
                } catch (e) {
                  console.error("Export failed:", e);
                  alert("Export failed — see console for details.");
                } finally {
                  if (undoStyle) undoStyle();
                  // Restore previous tab
                  if (prevTab !== "graph") setRightTab(prevTab);
                }
              }}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-[#f0c060]/60 bg-[#fef3e2] text-[#1c1410] hover:bg-[#fde9c9] transition-colors shrink-0 print:hidden"
              aria-label="Export debate as PDF"
              title="Export debate as PDF — includes title, graph, and full transcript"
            >
              📥 Export
            </button>
          </div>
          {/* Emotion legend dropdown */}
          {showLegend && (
            <div className="shrink-0 px-5 py-2 border-b border-[#f0ebe4] bg-white/80">
              <div className="grid grid-cols-3 gap-x-4 gap-y-1">
                {Object.entries(EMOTION_STYLE)
                  .filter(([key]) => key !== "neutral")
                  .map(([key, em]) => (
                    <div key={key} className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: em.dot }} />
                      <span className="text-[10px] text-[#6b5c4e]">{em.label}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          )}

          {/* Scrollable transcript */}
          <div
            ref={transcriptScrollRef}
            className="flex-1 overflow-y-auto px-5 py-5 space-y-1 min-h-0"
            onScroll={() => {
              const el = transcriptScrollRef.current;
              if (!el) return;
              // Consider "at bottom" if within 80px of the bottom
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              userScrolledUpRef.current = !atBottom;
            }}
          >


            {transcript.map((entry, i) => {
              const isTwoChar = activeCharacters.length === 2;
              const charIdx = activeCharacters.indexOf(entry.character);
              const isRight = isTwoChar && charIdx === 1;

              // Skip reactions (no longer generated)
              if ((entry as any).isReaction) return null;

              // Stage direction — atmospheric
              if ((entry as any).isStageDirection) return (
                <div key={i} className="mx-4 my-3 text-center">
                  <span className="text-xs italic text-[#c8b89a] leading-relaxed">
                    {entry.message}
                  </span>
                </div>
              );

              // Audience member message
              if ((entry as any).isAudience) return (
                <div key={i} className="my-3 mx-1">
                  <div className="rounded-xl px-4 py-3 border border-blue-200 bg-blue-50/60">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm">🙋</span>
                      <span className="text-xs font-bold text-blue-700">{entry.character}</span>
                      <span className="text-xs text-blue-400 italic">· audience</span>
                    </div>
                    <p className="text-sm text-blue-900 leading-relaxed">{entry.message}</p>
                  </div>
                </div>
              );

              // Boru the Elephant — Speaker of the Sabha
              if ((entry as any).isOrchestrator) return (
                <div key={i} className="my-4 mx-1">
                  <div className="rounded-2xl px-5 py-4 border border-[#c07820]/30 bg-gradient-to-r from-[#fef9f0] to-[#fef3e2]">
                    <div className="flex items-center gap-2.5 mb-2">
                      <span className="text-lg">🐘</span>
                      <span className="text-xs uppercase tracking-widest font-bold text-[#c07820]">Boru</span>
                      <span className="text-xs text-[#a09282] italic">· Speaker of the Sabha</span>
                      {(entry as any).phase && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#c07820]/10 border border-[#c07820]/20 text-[#c07820] font-medium uppercase tracking-wide">
                          {(entry as any).phase.replace(/_/g, " ")}
                        </span>
                      )}
                      {debateId && (
                        <div className="ml-auto flex items-center gap-0.5">
                          <button
                            onClick={() => toggleTTS(i)}
                            disabled={ttsLoading === i}
                            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-all ${
                              ttsPlaying === i
                                ? "bg-[#c07820] text-white shadow-sm"
                                : ttsLoading === i
                                  ? "bg-[#c07820]/10 text-[#c07820] animate-pulse"
                                  : "bg-transparent text-[#c8b89a] hover:bg-[#c07820]/10 hover:text-[#c07820]"
                            }`}
                            title={ttsPlaying === i ? "Stop" : "Play this message"}
                          >
                            {ttsPlaying === i ? "■" : "▶"}
                          </button>
                          <button
                            onClick={() => playFromHere(i)}
                            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] bg-transparent text-[#c8b89a] hover:bg-[#c07820]/10 hover:text-[#c07820] transition-all"
                            title="Play from here"
                          >
                            ▶▶
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="text-sm leading-relaxed text-[#3d2f20] font-medium">
                      <ReactMarkdown components={{
                        p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                        strong: ({children}) => <strong style={{fontWeight:700,color:"#c07820"}}>{children}</strong>,
                        em: ({children}) => <em style={{fontStyle:"italic",color:"#8a7260"}}>{children}</em>,
                      }}>{entry.message}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              );

              // World observer / interrogator entries
              if (entry.isObserver) return (
                <div key={i}>
                  {entry.character === "The Interrogator" ? (
                    <div className="my-4 mx-1 rounded-xl px-4 py-3 border border-zinc-600/60" style={{ background: "linear-gradient(135deg, #18181b 0%, #1c1917 100%)" }}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs uppercase tracking-widest font-bold text-zinc-400">⚖ The Interrogator</span>
                        <span className="text-xs text-zinc-600 italic">· structural voice</span>
                        {debateId && (
                          <div className="ml-auto flex items-center gap-0.5">
                            <button onClick={() => toggleTTS(i)} className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-all ${ttsPlaying === i ? "bg-zinc-500 text-white" : "text-zinc-600 hover:text-zinc-300"}`} title={ttsPlaying === i ? "Stop" : "Play"}>
                              {ttsPlaying === i ? "■" : "▶"}
                            </button>
                            <button onClick={() => playFromHere(i)} className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-zinc-600 hover:text-zinc-300 transition-all" title="Play from here">▶▶</button>
                          </div>
                        )}
                      </div>
                      <div className="text-sm leading-relaxed text-zinc-200">
                        <ReactMarkdown components={{
                          p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                          strong: ({children}) => <strong style={{fontWeight:600,color:"#e4e4e7"}}>{children}</strong>,
                          em: ({children}) => <em style={{fontStyle:"italic",color:"#a1a1aa"}}>{children}</em>,
                        }}>{entry.message}</ReactMarkdown>
                      </div>
                    </div>
                  ) : (
                    <div className="my-3 mx-1 bg-slate-900 rounded-xl px-4 py-3 border border-slate-700/60">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs uppercase tracking-widest font-bold text-slate-400">🌍 World Observer</span>
                        {entry.observerEra && <span className="text-xs text-slate-500 italic">· {entry.observerEra}</span>}
                        <span className="text-xs text-slate-400 font-medium ml-1">{entry.character}</span>
                        {debateId && (
                          <div className="ml-auto flex items-center gap-0.5">
                            <button onClick={() => toggleTTS(i)} className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-all ${ttsPlaying === i ? "bg-slate-500 text-white" : "text-slate-600 hover:text-slate-300"}`} title={ttsPlaying === i ? "Stop" : "Play"}>
                              {ttsPlaying === i ? "■" : "▶"}
                            </button>
                            <button onClick={() => playFromHere(i)} className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-slate-600 hover:text-slate-300 transition-all" title="Play from here">▶▶</button>
                          </div>
                        )}
                      </div>
                      <div className="text-sm leading-relaxed text-slate-200">
                        <ReactMarkdown components={{
                          p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                          strong: ({children}) => <strong style={{fontWeight:600,color:"#e2e8f0"}}>{children}</strong>,
                          em: ({children}) => <em style={{fontStyle:"italic",color:"#94a3b8"}}>{children}</em>,
                        }}>{entry.message}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              );

              const c = colorOf(entry.character);
              const em = EMOTION_STYLE[entry.emotion || "neutral"] || EMOTION_STYLE.neutral;
              const targetChar = entry.target && entry.target !== entry.character ? entry.target : null;
              const targetC = targetChar ? colorOf(targetChar) : null;
              // Find the last message from targetChar before this index for quote preview
              const quotedMsg = targetChar
                ? [...transcript.slice(0, i)].reverse().find(e => e.character === targetChar)
                : null;
              const quoteSnippet = quotedMsg
                ? quotedMsg.message.replace(/[*_#]/g, "").slice(0, 80) + (quotedMsg.message.length > 80 ? "…" : "")
                : null;

              return (
                <div key={i}>
                  <div className={`flex gap-3 py-1.5 ${isRight ? "flex-row-reverse" : ""}`}>
                    {(() => {
                      const charData = storyCharacters.find((sc: any) => sc.name === entry.character);
                      const portrait = charData?.portrait;
                      return portrait ? (
                        <img src={`${API}${portrait}`} alt={entry.character} loading="lazy"
                          className="w-8 h-8 rounded-full shrink-0 object-cover mt-0.5 shadow-sm"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white font-bold text-xs mt-0.5 shadow-sm"
                          style={{ backgroundColor: c.hex }}>
                          {initials(entry.character)}
                        </div>
                      );
                    })()}
                    <div className={`flex-1 min-w-0 ${isRight ? "items-end" : ""} flex flex-col`}>
                      <div className={`flex items-center gap-2 mb-1 flex-wrap ${isRight ? "flex-row-reverse" : ""}`}>
                        <span className="text-xs font-semibold" style={{ color: c.hex }}>{entry.character}</span>
                        {em.label && (
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: em.dot }} />
                            <span className="text-xs text-[#a09282]">{em.label}</span>
                          </span>
                        )}
                        {entry.isExploration && (
                          <span title="Hidden depth — character revealed something unexpected" className="text-xs text-[#c07820] font-medium">✦</span>
                        )}
                        {/* TTS buttons — top right */}
                        {debateId && (
                          <div className="ml-auto flex items-center gap-0.5">
                            <button
                              onClick={() => toggleTTS(i)}
                              disabled={ttsLoading === i}
                              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-all ${
                                ttsPlaying === i
                                  ? "bg-[#c07820] text-white shadow-sm"
                                  : ttsLoading === i
                                    ? "bg-[#f0ebe4] text-[#c8b89a] animate-pulse"
                                    : "bg-transparent text-[#c8b89a] hover:bg-[#f0ebe4] hover:text-[#c07820]"
                              }`}
                              title={ttsPlaying === i ? "Stop" : "Play this message"}
                            >
                              {ttsPlaying === i ? "■" : "▶"}
                            </button>
                            <button
                              onClick={() => playFromHere(i)}
                              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] bg-transparent text-[#c8b89a] hover:bg-[#f0ebe4] hover:text-[#c07820] transition-all"
                              title="Play from here"
                            >
                              ▶▶
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Reply quote preview (WhatsApp-style) */}
                      {quoteSnippet && (
                        <div className={`mb-1 px-3 py-1.5 rounded-lg text-xs text-[#6b5c4e] italic max-w-[90%] ${isRight ? "self-end" : "self-start"}`}
                          style={{ borderLeft: isRight ? undefined : `2px solid ${targetC?.hex}`, borderRight: isRight ? `2px solid ${targetC?.hex}` : undefined, backgroundColor: targetC?.hex + "12" }}>
                          <span className="font-semibold not-italic text-xs" style={{ color: targetC?.hex }}>{targetChar}</span>
                          <span className="mx-1 text-[#c8b89a]">·</span>
                          {quoteSnippet}
                        </div>
                      )}
                      <div className={`text-sm leading-relaxed px-3 py-2.5 text-[#1c1410] max-w-[90%] ${isRight ? "self-end rounded-l-xl rounded-br-xl" : "rounded-r-xl rounded-bl-xl self-start"}`}
                        style={{ borderLeft: isRight ? undefined : `3px solid ${em.dot}`, borderRight: isRight ? `3px solid ${em.dot}` : undefined, backgroundColor: em.bg }}>
                        <ReactMarkdown components={{
                          p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                          strong: ({children}) => <strong style={{fontWeight:600}}>{children}</strong>,
                          em: ({children}) => <em style={{fontStyle:"italic"}}>{children}</em>,
                          ul: ({children}) => <ul style={{listStyleType:"disc",paddingLeft:"1rem",marginTop:"0.25rem"}}>{children}</ul>,
                          li: ({children}) => <li style={{marginBottom:"0.1rem"}}>{children}</li>,
                        }}>{entry.message}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {streaming && (() => {
              const c = colorOf(streaming.character);
              const isChallengingNow = pendingChallenge?.character === streaming.character;
              return (
                <div>
                {isChallengingNow && (
                  <div className="mx-1 mb-2 px-4 py-2.5 rounded-xl bg-amber-950/80 border border-amber-700/60 flex items-start gap-2.5">
                    <span className="text-amber-400 mt-0.5 shrink-0">⚔</span>
                    <div>
                      <div className="text-xs uppercase tracking-widest text-amber-500 font-bold mb-0.5">{pendingChallenge.observerName} challenges</div>
                      <div className="text-sm text-amber-200 leading-snug italic">"{pendingChallenge.question}"</div>
                    </div>
                  </div>
                )}
                <div className="flex gap-3 py-1.5">
                  <div className="relative w-8 h-8 shrink-0 mt-0.5">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs"
                      style={{ backgroundColor: c.hex, boxShadow: `0 0 0 3px ${c.hex}40, 0 0 14px ${c.hex}50` }}>
                      {initials(streaming.character)}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-white animate-pulse" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold" style={{ color: c.hex }}>{streaming.character}</span>
                      {!streaming.text && (
                        <span className="flex gap-0.5 items-center ml-1">
                          <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce" style={{ color: c.hex, animationDelay: "0ms" }} />
                          <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce" style={{ color: c.hex, animationDelay: "150ms" }} />
                          <span className="w-1 h-1 rounded-full bg-current opacity-60 animate-bounce" style={{ color: c.hex, animationDelay: "300ms" }} />
                        </span>
                      )}
                    </div>
                    {streaming.text && (
                      <div className="text-sm leading-relaxed rounded-r-xl rounded-bl-xl px-3 py-2.5 text-[#1c1410]"
                        style={{ borderLeft: `3px solid ${c.hex}60`, backgroundColor: "rgba(255,255,255,0.7)" }}>
                        <ReactMarkdown components={{
                          p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                          strong: ({children}) => <strong style={{fontWeight:600}}>{children}</strong>,
                          em: ({children}) => <em style={{fontStyle:"italic"}}>{children}</em>,
                          ul: ({children}) => <ul style={{listStyleType:"disc",paddingLeft:"1rem",marginTop:"0.25rem"}}>{children}</ul>,
                          li: ({children}) => <li style={{marginBottom:"0.1rem"}}>{children}</li>,
                        }}>{streaming.text}</ReactMarkdown>
                        <span className="animate-pulse text-[#c07820]">▌</span>
                      </div>
                    )}
                  </div>
                </div>
                </div>
              );
            })()}

            {streamingSummary && !debateSummary && (
              <div className="mt-8 pt-8 border-t border-[#e8e0d5]">
                <div className="flex items-center gap-2 text-xs text-[#a09282] mb-5 uppercase tracking-widest font-medium">
                  <span className="animate-breathe text-[#c07820]">✦</span> Summarizing the debate…
                </div>
                <div className="text-[#2d1f14] leading-relaxed text-sm">
                  {streamingSummary}<span className="animate-pulse text-[#c07820]">▌</span>
                </div>
              </div>
            )}

            {status === "done" && debateSummary && (
              <div className="mt-8 pt-8 border-t border-[#e8e0d5] space-y-3">
                <button
                  onClick={() => setShowConclusion(true)}
                  className="w-full py-4 rounded-2xl bg-[#1c1410] text-white font-semibold text-sm hover:bg-[#2d1f14] transition-colors flex items-center justify-center gap-2"
                >
                  <span className="text-[#f0c060]">&#9670;</span> Read the Debate Summary
                </button>
                <button
                  onClick={regenerateSummary}
                  disabled={regenerating}
                  className="block w-full text-center text-xs text-[#a09282] hover:text-[#6b5c4e] transition-colors py-1.5 disabled:opacity-50"
                >
                  {regenerating ? "Regenerating summary…" : "↻ Regenerate summary"}
                </button>
                <button
                  onClick={() => { window.location.href = `/story/${id}/debate`; }}
                  className="block w-full text-center text-sm text-[#a09282] hover:text-[#6b5c4e] transition-colors py-2 font-medium"
                >
                  Start another debate →
                </button>
              </div>
            )}
            {status === "done" && !debateSummary && !alternateEnding && transcript.length > 0 && (
              <div className="mt-8 pt-8 border-t border-[#e8e0d5] space-y-3">
                <div className="text-center py-6 px-4 rounded-2xl border border-[#e8e0d5] bg-white">
                  <p className="text-sm text-[#6b5c4e] mb-4">No written summary was generated for this debate.</p>
                  <button
                    onClick={regenerateSummary}
                    disabled={regenerating}
                    className="px-5 py-2.5 rounded-xl bg-[#1c1410] text-white text-sm font-semibold hover:bg-[#2d1f14] transition-colors disabled:opacity-60"
                  >
                    {regenerating ? "Summarizing…" : "✦ Summarize this debate"}
                  </button>
                </div>
                <button
                  onClick={() => { window.location.href = `/story/${id}/debate`; }}
                  className="block w-full text-center text-sm text-[#a09282] hover:text-[#6b5c4e] transition-colors py-2 font-medium"
                >
                  Start a new debate →
                </button>
              </div>
            )}

            <div ref={bottomRef} className="h-8" />
          </div>

          {/* Bottom tab bar */}
          <div className="shrink-0 border-t border-[#e8e0d5] bg-white flex">
            {(["debate", "agents", "chat"] as const).map(tab => (
              <button key={tab}
                onClick={() => setLeftTab(prev => prev === tab ? "debate" : tab)}
                className={`flex-1 py-3 text-sm font-semibold tracking-wide transition-colors border-t-2 ${
                  leftTab === tab
                    ? "border-[#c07820] text-[#c07820] bg-[#fef3e2]/50"
                    : "border-transparent text-[#a09282] hover:text-[#6b5c4e] hover:bg-[#faf7f2]"
                }`}
              >
                {tab === "debate" ? "Debate" : tab === "agents" ? "◈ Agents" : "✦ Chat"}
              </button>
            ))}
          </div>

          {/* Agents panel */}
          {leftTab === "agents" && (
            <div className="shrink-0 overflow-y-auto bg-[#f7f3ed] border-t border-[#e8e0d5]" style={{ height: "320px" }}>
              {activeCharacters.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-[#c8b89a]">Debate hasn't started yet.</div>
              ) : (
                <div className="px-4 py-3 space-y-3">
                  {/* Algorithm legend — once only */}
                  <div className="bg-white border border-[#e8e0d5] rounded-xl px-3 py-2.5">
                    <div className="text-xs uppercase tracking-widest text-[#a09282] font-semibold mb-1.5">System</div>
                    <div className="space-y-1 text-xs text-[#6b5c4e] leading-relaxed">
                      <div><span className="font-semibold text-[#1c1410]">Speaker selection:</span> reward-priority scoring</div>
                      <div className="text-[#a09282] pl-2 space-y-0.5">
                        <div>+3 direct question · +2 named · +1/silent turn</div>
                        <div>−1/recent turn · −999 last speaker</div>
                      </div>
                      <div><span className="font-semibold text-[#1c1410]">Response:</span> LLM sampling, temp 0.85</div>
                      <div><span className="font-semibold text-[#1c1410]">Continuation:</span> judge grants if score &lt; 5</div>
                    </div>
                  </div>

                  {/* Per-character cards */}
                  {activeCharacters.map((name, ci) => {
                    const col = CHAR_COLORS[ci % CHAR_COLORS.length].hex;
                    const charEntries = transcript.filter(e => e.character === name && !e.isObserver);
                    const speeches = charEntries.length;

                    // Avg judge score
                    const scored = charEntries.filter(e => e.judgeScore !== undefined);
                    const avgScore = scored.length > 0
                      ? scored.reduce((s, e) => s + (e.judgeScore ?? 0), 0) / scored.length
                      : null;

                    // Current emotion (last entry)
                    const lastEmotion = charEntries[charEntries.length - 1]?.emotion ?? "neutral";
                    const emotionStyle = EMOTION_STYLE[lastEmotion] || EMOTION_STYLE.neutral;

                    // Exploration count
                    const explorations = charEntries.filter(e => e.isExploration).length;

                    // Questions asked vs received
                    const qAsked = charEntries.filter(e => e.target && e.target !== name && e.message.includes("?")).length;
                    const qReceived = transcript.filter(e => e.target === name && e.message.includes("?")).length;

                    // Silence turns (urgency) — how many turns since last speech
                    const lastSpeechIdx = transcript.map(e => e.character).lastIndexOf(name);
                    const silenceTurns = lastSpeechIdx === -1
                      ? transcript.length
                      : transcript.length - lastSpeechIdx - 1;
                    const urgency = Math.min(silenceTurns * 0.25, 1); // 0→1 over 4 silent turns
                    const isCurrentlySpeaking = streaming?.character === name;

                    return (
                      <div key={name} className="bg-white border border-[#e8e0d5] rounded-xl overflow-hidden"
                        style={{ borderLeftColor: col, borderLeftWidth: 3 }}>
                        {/* Header */}
                        <div className="px-3 py-2 flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0"
                            style={{ backgroundColor: col }}>
                            {initials(name)}
                          </div>
                          <span className="font-semibold text-sm text-[#1c1410] flex-1 truncate">{name}</span>
                          {isCurrentlySpeaking && (
                            <span className="flex items-center gap-1 text-xs text-emerald-600 font-semibold">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />speaking
                            </span>
                          )}
                          {!isCurrentlySpeaking && urgency > 0.5 && (
                            <span className="text-xs text-[#c07820] font-semibold">↑ high urgency</span>
                          )}
                        </div>

                        {/* Stats grid */}
                        <div className="px-3 pb-2.5 grid grid-cols-3 gap-x-3 gap-y-1.5">
                          <div>
                            <div className="text-xs text-[#a09282] uppercase tracking-widest">Speeches</div>
                            <div className="text-sm font-bold text-[#1c1410]">{speeches}</div>
                          </div>
                          <div>
                            <div className="text-xs text-[#a09282] uppercase tracking-widest">Avg score</div>
                            <div className="text-sm font-bold" style={{ color: avgScore ? (avgScore >= 7 ? "#10b981" : avgScore >= 5 ? "#c07820" : "#ef4444") : "#c8b89a" }}>
                              {avgScore !== null ? avgScore.toFixed(1) : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-[#a09282] uppercase tracking-widest">Explored</div>
                            <div className="text-sm font-bold text-[#a855f7]">{explorations > 0 ? `${explorations}×` : "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-[#a09282] uppercase tracking-widest">Q asked</div>
                            <div className="text-sm font-bold text-[#3b82f6]">{qAsked}</div>
                          </div>
                          <div>
                            <div className="text-xs text-[#a09282] uppercase tracking-widest">Q received</div>
                            <div className="text-sm font-bold text-[#3b82f6]">{qReceived}</div>
                          </div>
                          <div>
                            <div className="text-xs text-[#a09282] uppercase tracking-widest">Emotion</div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: emotionStyle.dot }} />
                              <span className="text-xs text-[#6b5c4e] truncate">{emotionStyle.label || "neutral"}</span>
                            </div>
                          </div>
                        </div>

                        {/* Urgency bar */}
                        <div className="px-3 pb-2.5">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-[#a09282] uppercase tracking-widest">Urgency</span>
                            <span className="text-xs text-[#a09282]">{silenceTurns} silent turn{silenceTurns !== 1 ? "s" : ""}</span>
                          </div>
                          <div className="h-1.5 bg-[#f0ebe4] rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${urgency * 100}%`, backgroundColor: urgency > 0.75 ? "#ef4444" : urgency > 0.4 ? "#c07820" : col }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Audience participation — during running debate */}
          {(status === "running" || status === "done") && (
            <div className="shrink-0 border-t border-[#e8e0d5] bg-white px-4 py-2.5">
              {!audienceNameSet ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#a09282] shrink-0">🙋 Join the Sabha as:</span>
                  <input
                    value={audienceName}
                    onChange={e => setAudienceName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && audienceName.trim()) setAudienceNameSet(true); }}
                    placeholder="Your name..."
                    className="flex-1 bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-lg px-3 py-1.5 text-xs text-[#1c1410] placeholder-[#c8b89a] focus:outline-none transition-colors"
                  />
                  <button
                    onClick={() => { if (audienceName.trim()) setAudienceNameSet(true); }}
                    disabled={!audienceName.trim()}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[#c07820] hover:bg-[#a86a18] disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white font-medium transition-colors"
                  >Join</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#c07820] font-semibold shrink-0">🙋 {audienceName}:</span>
                  <input
                    value={audienceInput}
                    onChange={e => setAudienceInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") sendAudienceMessage(); }}
                    placeholder="Ask a question or comment on the debate..."
                    className="flex-1 bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-lg px-3 py-1.5 text-xs text-[#1c1410] placeholder-[#c8b89a] focus:outline-none transition-colors"
                  />
                  <button
                    onClick={sendAudienceMessage}
                    disabled={!audienceInput.trim()}
                    className="w-7 h-7 rounded-lg bg-[#c07820] hover:bg-[#a86a18] disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white flex items-center justify-center text-sm transition-colors shrink-0"
                  >↑</button>
                </div>
              )}
            </div>
          )}

          {/* Chat panel */}
          {leftTab === "chat" && (
            <div className="shrink-0 flex flex-col bg-white border-t border-[#e8e0d5]" style={{ height: "280px" }}>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
                {chatMessages.length === 0 && (
                  <div className="space-y-1.5 pt-1">
                    {["Why did they say that?", "Who has the upper hand?", "What happens next?"].map(q => (
                      <button key={q} onClick={() => setChatInput(q)}
                        className="w-full text-left text-sm text-[#6b5c4e] bg-[#f7f3ed] hover:bg-[#fef3e2] border border-[#e8e0d5] hover:border-[#f0c060]/50 px-4 py-3 rounded-xl transition-colors leading-relaxed">
                        {q}
                      </button>
                    ))}
                  </div>
                )}
                {chatMessages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    {m.role === "assistant" && (
                      <div className="w-5 h-5 rounded-md bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs shrink-0 mr-1.5 mt-0.5">✦</div>
                    )}
                    <div className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                      m.role === "user"
                        ? "bg-[#c07820] text-white rounded-br-sm"
                        : "bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] rounded-bl-sm"
                    }`}>
                      {m.role === "assistant" ? (
                        <ReactMarkdown components={{
                          p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                          strong: ({children}) => <strong style={{fontWeight:600}}>{children}</strong>,
                          ul: ({children}) => <ul style={{listStyleType:"disc",paddingLeft:"1rem",marginTop:"0.25rem"}}>{children}</ul>,
                          ol: ({children}) => <ol style={{listStyleType:"decimal",paddingLeft:"1rem",marginTop:"0.25rem"}}>{children}</ol>,
                          li: ({children}) => <li style={{marginBottom:"0.1rem"}}>{children}</li>,
                          h3: ({children}) => <p style={{fontWeight:600,marginTop:"0.5rem",marginBottom:"0.1rem"}}>{children}</p>,
                          h2: ({children}) => <p style={{fontWeight:600,marginTop:"0.5rem",marginBottom:"0.1rem"}}>{children}</p>,
                        }}>{typeof m.content === "string" ? m.content : String(m.content)}</ReactMarkdown>
                      ) : (
                        typeof m.content === "string" ? m.content : String(m.content)
                      )}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="w-5 h-5 rounded-md bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs shrink-0 mr-1.5 mt-0.5">✦</div>
                    <div className="bg-[#f7f3ed] border border-[#e8e0d5] px-3 py-2 rounded-xl rounded-bl-sm flex gap-1 items-center h-8">
                      <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay:"0ms" }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay:"300ms" }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay:"600ms" }} />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              <div className="px-3 py-2.5 border-t border-[#e8e0d5] shrink-0 flex gap-2 items-center">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") sendDebateChat(); }}
                  placeholder="Ask about the debate…"
                  className="flex-1 bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-lg px-3 py-2 text-xs text-[#1c1410] placeholder-[#c8b89a] focus:outline-none transition-colors"
                />
                <button
                  onClick={sendDebateChat}
                  disabled={!chatInput.trim() || chatLoading}
                  className="w-8 h-8 rounded-lg bg-[#c07820] hover:bg-[#a86a18] disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white flex items-center justify-center text-sm transition-colors shrink-0"
                >↑</button>
              </div>
            </div>
          )}
        </div>

        {/* ══ Drag handle ══ */}
        {maximize === "none" && (
          <div
            data-print-hide="true"
            className={`w-1.5 shrink-0 transition-colors cursor-col-resize group relative ${isDraggingSplit ? "bg-[#c07820]" : "bg-[#e8e0d5] hover:bg-[#c07820]/60"}`}
            onMouseDown={() => { isDraggingRef.current = true; setIsDraggingSplit(true); }}
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-1 pointer-events-none">
              <div className={`w-0.5 h-0.5 rounded-full transition-colors ${isDraggingSplit ? "bg-white" : "bg-[#c8b89a] group-hover:bg-[#c07820]"}`} />
              <div className={`w-0.5 h-0.5 rounded-full transition-colors ${isDraggingSplit ? "bg-white" : "bg-[#c8b89a] group-hover:bg-[#c07820]"}`} />
              <div className={`w-0.5 h-0.5 rounded-full transition-colors ${isDraggingSplit ? "bg-white" : "bg-[#c8b89a] group-hover:bg-[#c07820]"}`} />
            </div>
          </div>
        )}

        {/* ══ RIGHT: Graph / Heatmap / Emotions ══ */}
        <div data-print-hide="true" className="flex flex-col overflow-hidden bg-[#f7f3ed]"
          style={{ flex: maximize === "left" ? 0 : 1, width: maximize === "left" ? "0px" : maximize === "right" ? "100%" : `${100 - splitPct}%`, display: maximize === "left" ? "none" : "flex" }}>

          {/* Right panel tabs */}
          <div className="shrink-0 flex border-b border-[#e8e0d5] bg-[#f0ece5]">
            {(["graph", "ledger", "positions"] as const).map(tab => (
              <button key={tab} onClick={() => setRightTab(tab)}
                className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
                  rightTab === tab
                    ? "text-[#3d2f20] border-[#c07820]"
                    : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
                }`}>
                {tab === "graph" ? "⬡ Graph" : tab === "ledger" ? "📋 Ledger" : "🎭 Positions"}
              </button>
            ))}
          </div>

          {/* Canvas layers */}
          <div className="flex-1 relative min-h-0">
            {/* Graph */}
            <div ref={graphWrapperRef} style={{ position:"absolute", inset:0, opacity: rightTab==="graph" ? 1 : 0, pointerEvents: rightTab==="graph" ? "auto" : "none", transition:"opacity 0.15s", background: "#ffffff" }}>
              <svg ref={graphSvgRef} style={{ display:"block", width:"100%", height:"100%" }} />
              {graphHover && (
                <div className="absolute pointer-events-none z-10 max-w-[220px]"
                  style={{ left: graphHover.x + 14, top: graphHover.y - 8 }}>
                  <div className="rounded-xl border border-[#e0d8ce] shadow-xl px-3 py-2.5 space-y-1.5" style={{ background: "rgba(255,252,248,0.97)", backdropFilter: "blur(8px)" }}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold" style={{ color: CHAR_COLORS[activeCharacters.indexOf(graphHover.source) % CHAR_COLORS.length]?.hex }}>{graphHover.source}</span>
                      <span className="text-[#a09282] text-xs">→</span>
                      <span className="text-xs font-bold" style={{ color: CHAR_COLORS[activeCharacters.indexOf(graphHover.target) % CHAR_COLORS.length]?.hex }}>{graphHover.target}</span>
                    </div>
                    <div className="flex gap-2 text-xs text-[#a09282]">
                      <span>{graphHover.count} exchange{graphHover.count !== 1 ? "s" : ""}</span>
                      {graphHover.questions > 0 && <><span>·</span><span className="text-[#c07820]/80">{graphHover.questions} question{graphHover.questions !== 1 ? "s" : ""}</span></>}
                    </div>
                    {graphHover.snippet && (
                      <p className="text-xs text-[#6b5c4e] leading-relaxed border-t border-[#e8e0d5] pt-1.5 italic">"{graphHover.snippet}"</p>
                    )}
                  </div>
                </div>
              )}
              {/* Zoom/pan handled by D3 — scroll to zoom, drag to pan, drag node to move */}
              {/* Legend */}
              <div className="absolute bottom-3 left-3 bg-white/90 backdrop-blur-sm border border-[#d8cfc5] rounded-xl shadow-sm overflow-hidden">
                <button className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#f7f3ed] transition-colors"
                  onClick={() => setGraphLegendCollapsed(v => !v)}>
                  <span className="text-[#a09282] text-xs uppercase tracking-widest font-medium">Legend</span>
                  <span className="text-[#a09282] text-xs ml-3">{graphLegendCollapsed ? "▸" : "▾"}</span>
                </button>
                {!graphLegendCollapsed && (
                  <div className="px-3 pb-2.5 space-y-1.5 border-t border-[#e8e0d5]">
                    <div className="flex items-center gap-2 pt-1.5"><div className="w-8 h-px bg-[#8a7260]/50" /><span className="text-[#8a7260] text-xs">Response (solid)</span></div>
                    <div className="flex items-center gap-2"><div className="w-8 border-t border-dashed border-[#8a7260]/70" /><span className="text-[#8a7260] text-xs">Question (dotted)</span></div>
                    <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#8a7260]/40 border border-[#8a7260]/40" /><span className="text-[#a09282] text-xs">Node size = speeches</span></div>
                    <div className="flex items-center gap-2"><div className="w-3 h-0.5 bg-[#8a7260]/50" /><span className="text-[#a09282] text-xs">Color = speaker</span></div>
                  </div>
                )}
              </div>
            </div>
            {/* Argument Ledger — collapsible sections */}
            <div className="overflow-y-auto p-3 space-y-2" style={{ position:"absolute", inset:0, opacity: rightTab==="ledger" ? 1 : 0, pointerEvents: rightTab==="ledger" ? "auto" : "none", transition:"opacity 0.15s" }}>

              {/* Boru's Notes — timeline of every progress note taken during the debate */}
              <BoruNotesTimeline
                history={ledgerState.progress_history}
                latest={ledgerState.progress}
                phase={ledgerState.phase}
              />


              {/* Open Questions — with answers threaded below */}
              <LedgerSection
                title="Open Questions"
                count={ledgerState.open_questions.length}
                badge={<span className="text-amber-600">{ledgerState.open_questions.filter((q: any) => q.status === "unanswered").length} unanswered</span>}
                defaultOpen={true}
                empty="No open questions yet"
              >
                {ledgerState.open_questions.map((q: any, i: number) => (
                  <div key={`${q.id || "oq"}-${i}`} className={`border rounded-lg overflow-hidden ${q.status === "unanswered" ? "border-amber-200" : "border-[#e8e0d5]"}`}>
                    <div className={`px-3 py-2 ${q.status === "unanswered" ? "bg-amber-50/60" : "bg-white"}`}>
                      <p className="text-xs text-[#1c1410] leading-relaxed font-medium">{q.question}</p>
                      <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[#a09282]">
                        <span>Asked by <span className="font-medium text-[#6b5c4e]">{q.asked_by}</span></span>
                        <span>→</span>
                        <span className="font-medium text-[#6b5c4e]">{(q.directed_to || []).join(", ")}</span>
                        <span className={`ml-auto px-1.5 py-0.5 rounded font-medium ${q.status === "unanswered" ? "text-amber-700 bg-amber-100" : q.status === "resolved" ? "text-emerald-700 bg-emerald-50" : "text-blue-600 bg-blue-50"}`}>{q.status}</span>
                      </div>
                    </div>
                    {/* Answers threaded below the question */}
                    {q.answers && Object.keys(q.answers).length > 0 && (
                      <div className="border-t border-[#e8e0d5] bg-[#f7f3ed] px-3 py-2 space-y-1.5">
                        {Object.entries(q.answers).map(([who, answer]: [string, any]) => (
                          <div key={who} className="flex gap-2 text-[11px]">
                            <span className="font-semibold text-[#6b5c4e] shrink-0">{who}:</span>
                            <span className="text-[#1c1410] leading-relaxed">{String(answer)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </LedgerSection>

              {/* Resolved Questions */}
              {ledgerState.resolved_questions.length > 0 && (
                <LedgerSection
                  title="Resolved"
                  count={ledgerState.resolved_questions.length}
                  badge={<span className="text-emerald-600">✓</span>}
                  defaultOpen={false}
                  empty=""
                >
                  {ledgerState.resolved_questions.map((q: any, i: number) => (
                    <div key={`${q.id || "rq"}-${i}`} className="border border-emerald-200 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-emerald-50/40">
                        <p className="text-xs text-[#6b5c4e] leading-relaxed line-through decoration-emerald-300">{q.question}</p>
                      </div>
                      {q.answers && Object.keys(q.answers).length > 0 && (
                        <div className="border-t border-emerald-100 bg-white px-3 py-2 space-y-1">
                          {Object.entries(q.answers).map(([who, answer]: [string, any]) => (
                            <div key={who} className="flex gap-2 text-[11px]">
                              <span className="font-semibold text-emerald-700 shrink-0">{who}:</span>
                              <span className="text-[#6b5c4e]">{String(answer)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </LedgerSection>
              )}

              {/* Claims — active and resolved */}
              {ledgerState.claims.length > 0 && (
                <LedgerSection
                  title="Claims & Disputes"
                  count={ledgerState.claims.length}
                  badge={<span className="text-[#c07820]">{ledgerState.claims.filter((c: any) => c.status === "disputed").length} disputed</span>}
                  defaultOpen={true}
                  empty=""
                >
                  {ledgerState.claims.map((c: any, i: number) => (
                    <div key={i} className={`border rounded-lg px-3 py-2 ${c.status === "disputed" ? "border-red-200 bg-red-50/30" : c.status === "resolved" ? "border-emerald-200 bg-emerald-50/20" : "border-[#e8e0d5] bg-white"}`}>
                      <div className="flex items-start gap-1.5">
                        <span className="text-xs font-bold text-[#1c1410] shrink-0">{c.character}:</span>
                        <span className="text-xs text-[#6b5c4e] leading-relaxed">&ldquo;{c.claim}&rdquo;</span>
                      </div>
                      {c.challenged_by?.length > 0 && (
                        <div className="mt-1.5 pl-2 border-l-2 border-red-200">
                          <span className="text-[10px] text-red-500 font-medium">Challenged by {c.challenged_by.join(", ")}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-end mt-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${c.status === "disputed" ? "text-red-600 bg-red-100" : c.status === "resolved" ? "text-emerald-600 bg-emerald-100" : "text-[#a09282] bg-[#f0ebe4]"}`}>{c.status}</span>
                      </div>
                    </div>
                  ))}
                </LedgerSection>
              )}

              {/* Empty state */}
              {ledgerState.open_questions.length === 0 && ledgerState.claims.length === 0 && !ledgerState.progress && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <span className="text-2xl mb-2">🐘</span>
                  <p className="text-sm text-[#a09282]">Boru is listening...</p>
                  <p className="text-xs text-[#c8b89a] mt-1">The ledger fills as the debate progresses</p>
                </div>
              )}
            </div>

            {/* Character Positions */}
            <div className="overflow-y-auto p-4 space-y-3" style={{ position:"absolute", inset:0, opacity: rightTab==="positions" ? 1 : 0, pointerEvents: rightTab==="positions" ? "auto" : "none", transition:"opacity 0.15s" }}>
              {Object.keys(ledgerState.positions).length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <span className="text-2xl mb-2">🎭</span>
                  <p className="text-sm text-[#a09282]">Waiting for characters to speak</p>
                  <p className="text-xs text-[#c8b89a] mt-1">Each character&apos;s stance will appear here</p>
                </div>
              ) : (
                activeCharacters.map((name, i) => {
                  const pos = ledgerState.positions[name];
                  const stats = graphStats.find(g => g.id === name);
                  const charData = storyCharacters.find(c => c.name === name);
                  const col = CHAR_COLORS[i % CHAR_COLORS.length];
                  if (!pos) return null;
                  return (
                    <div key={name} className="bg-white border border-[#e8e0d5] rounded-xl p-3.5">
                      <div className="flex items-center gap-2.5 mb-2">
                        {charData?.portrait ? (
                          <img src={`${API}${charData.portrait}`} alt={name} loading="lazy"
                            className="w-8 h-8 rounded-full object-cover shrink-0 shadow-sm" />
                        ) : (
                          <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white font-bold text-xs"
                            style={{ backgroundColor: col.hex }}>
                            {name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-semibold text-[#1c1410]">{name}</span>
                          {charData?.role && (
                            <span className="text-[10px] text-[#a09282] ml-1.5 capitalize">{charData.role}</span>
                          )}
                        </div>
                        {stats && (
                          <span className="text-[10px] text-[#c8b89a] shrink-0">{stats.speeches} turns</span>
                        )}
                      </div>
                      <p className="text-xs text-[#6b5c4e] leading-relaxed">{pos}</p>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Voice share */}
          {graphStats.length > 0 && rightTab === "graph" && (() => {
            const sorted = [...graphStats].sort((a, b) => b.speeches - a.speeches);
            const maxSpeeches = sorted[0]?.speeches || 1;
            const total = sorted.reduce((s, n) => s + n.speeches, 0) || 1;
            return (
              <div className="shrink-0 border-t border-[#e8e0d5] bg-[#f0ece5]">
                <button onClick={() => setShowStats(v => !v)} className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[#e8e0d5]/60 transition-colors">
                  <span className="text-xs uppercase tracking-widest text-[#a09282] font-medium">Voice share</span>
                  <span className="text-[#a09282] text-xs">{showStats ? "▾" : "▸"}</span>
                </button>
                {showStats && <div className="px-3 pb-2.5 space-y-1.5">{sorted.map(n => (
                  <div key={n.id} className="flex items-center gap-2">
                    <span className="text-xs text-[#8a7260] w-14 shrink-0 truncate">{n.id.split(" ")[0]}</span>
                    <div className="flex-1 h-1.5 bg-[#d8cfc5] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(n.speeches / maxSpeeches) * 100}%`, backgroundColor: n.color }} />
                    </div>
                    <span className="text-xs font-bold w-8 text-right shrink-0" style={{ color: n.color }}>{Math.round((n.speeches / total) * 100)}%</span>
                  </div>
                ))}</div>}
              </div>
            );
          })()}
        </div>

      </div>

      {/* ── Full-screen Book Conclusion — two-column layout ── */}
      {showConclusion && debateSummary && (
        <div className="absolute inset-0 z-50 flex flex-col" style={{ background: "#f7f3ed" }}>

          {/* Sticky nav */}
          <div className="shrink-0 border-b border-[#e8e0d5] flex items-center justify-between px-8 py-3" style={{ background: "rgba(247,243,237,0.97)", backdropFilter: "blur(12px)" }}>
            <span className="text-[#c07820] font-bold text-sm tracking-wider">✦ WhatIfSabha</span>
            <div className="flex items-center gap-2">
              <button onClick={() => { window.location.href = `/story/${id}/debate`; }} className="text-sm text-[#6b5c4e] hover:text-[#1c1410] border border-[#e8e0d5] hover:border-[#c8b89a] px-4 py-2 rounded-lg transition-colors font-medium">New debate →</button>
              <button onClick={() => setShowConclusion(false)} className="text-sm text-[#6b5c4e] hover:text-[#1c1410] border border-[#e8e0d5] hover:border-[#c8b89a] px-4 py-2 rounded-lg transition-colors font-medium">← Back</button>
            </div>
          </div>

          {/* Split body */}
          <div className="flex-1 flex overflow-hidden">

          {/* LEFT column — scrollable story content */}
          <div className="flex-1 overflow-y-auto" style={{ background: "#f7f3ed" }}>

          {/* HERO */}
          <div className="relative flex flex-col items-center justify-center text-center px-8 py-32 overflow-hidden" style={{ minHeight: "50vh" }}>
            <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 80% 60% at 50% 40%, rgba(192,120,32,0.1) 0%, transparent 70%)" }} />
            <div className="relative z-10 space-y-7 max-w-3xl">
              <div className="text-[#c07820] text-xs uppercase tracking-[0.45em] font-semibold">Debate Concluded</div>
              <h1 className="text-5xl sm:text-6xl font-bold leading-tight text-[#1c1410]">{divergence}</h1>
              <div className="flex items-center justify-center gap-5 text-sm text-[#6b5c4e]">
                <span>{activeCharacters.length} characters</span>
                <span className="text-[#d8cfc5]">·</span>
                <span>{transcript.length} exchanges</span>
                {alternateTimeline.length > 0 && <><span className="text-[#d8cfc5]">·</span><span>{alternateTimeline.length} events</span></>}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {activeCharacters.map((name, i) => (
                  <div key={name} className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#e8e0d5] bg-white/70">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: CHAR_COLORS[i % CHAR_COLORS.length].hex }} />
                    <span className="text-sm font-medium text-[#3d2f20]">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* TIMELINE */}
          {alternateTimeline.length > 0 && (
            <div style={{ background: "#f7f3ed" }} className="py-20 px-8">
              <div className="max-w-3xl mx-auto">
                <div className="text-center mb-14">
                  <div className="text-xs uppercase tracking-[0.35em] text-[#a09282] font-semibold mb-2">Timeline</div>
                  <div className="text-xl font-bold text-[#1c1410]">How this world unfolds</div>
                </div>
                <div className="relative">
                  <div className="absolute top-6 bottom-6 w-0.5 rounded-full" style={{ left: "23px", background: "linear-gradient(to bottom, #c07820, #e8e0d5 40%, #10b981)" }} />
                  <div className="space-y-6">
                    {alternateTimeline.map((ev: any, i: number) => {
                      const typeColor: Record<string, string> = { divergence: "#c07820", turning_point: "#3b82f6", consequence: "#78716c", resolution: "#10b981" };
                      const typeIcon: Record<string, string> = { divergence: "⟁", turning_point: "◈", consequence: "→", resolution: "✦" };
                      const col = typeColor[ev.type] || "#a09282";
                      const icon = typeIcon[ev.type] || "·";
                      return (
                        <div key={i} className="flex gap-6 items-start">
                          <div className="w-12 h-12 rounded-full border-2 bg-white shrink-0 flex items-center justify-center z-10 shadow-sm" style={{ borderColor: col }}>
                            <span style={{ color: col, fontSize: "15px", fontWeight: 700 }}>{icon}</span>
                          </div>
                          <div className="flex-1 bg-white border border-[#e8e0d5] rounded-2xl px-6 py-4 shadow-sm">
                            <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
                              <div>
                                <span className="text-xs uppercase tracking-widest font-bold" style={{ color: col }}>{(ev.type || "").replace(/_/g, " ")}</span>
                                <h3 className="font-bold text-[#1c1410] text-base mt-0.5">{ev.label}</h3>
                              </div>
                              {ev.characters?.length > 0 && (
                                <div className="flex flex-wrap gap-1 shrink-0">
                                  {(ev.characters as string[]).map((c: string, ci2: number) => {
                                    const ci = activeCharacters.indexOf(c);
                                    const ccol = CHAR_COLORS[ci >= 0 ? ci % CHAR_COLORS.length : 0].hex;
                                    return <span key={`evc-${ci2}-${c}`} className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: ccol + "18", color: ccol }}>{c}</span>;
                                  })}
                                </div>
                              )}
                            </div>
                            <p className="text-sm text-[#6b5c4e] leading-relaxed">{ev.description}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* DEBATE SUMMARY */}
          {debateSummary && (
            <div style={{ background: "#f7f3ed" }} className="py-16">
              <div className="max-w-[780px] mx-auto px-8 lg:px-12">
                <div className="text-center mb-10">
                  <div className="flex items-center justify-center gap-5 mb-6">
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                    <span className="text-[#6b5c4e] text-lg">&#9670;</span>
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                  </div>
                  <div className="text-xs uppercase tracking-[0.4em] text-[#a09282] font-semibold">The Debate</div>
                  {(debateId || debateIdRef.current) && debateSummary && (
                    <button
                      onClick={playSummaryTTS}
                      disabled={summaryLoading}
                      className={`mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold transition-all ${
                        summaryPlaying
                          ? "bg-[#c07820] text-white shadow-md"
                          : summaryLoading
                            ? "bg-[#f0ebe4] text-[#c8b89a] animate-pulse"
                            : "bg-white text-[#6b5c4e] border border-[#e8e0d5] hover:border-[#c07820] hover:text-[#c07820]"
                      }`}
                    >
                      {summaryPlaying ? "■ Stop Narration" : summaryLoading ? "Loading..." : "▶ Listen to Summary"}
                    </button>
                  )}
                </div>
                <div className="text-[#2d1f14] leading-relaxed text-[15px] prose prose-stone max-w-none">
                  <ReactMarkdown components={{
                    p: ({children}) => <p className="mb-4">{children}</p>,
                    strong: ({children}) => <strong className="font-semibold text-[#1c1410]">{children}</strong>,
                    em: ({children}) => <em className="italic text-[#6b5c4e]">{children}</em>,
                  }}>{debateSummary}</ReactMarkdown>
                </div>
              </div>
            </div>
          )}

          {/* END MARKER */}
          <div style={{ background: "#fefcf8" }} className="py-12">
            <div className="max-w-[780px] mx-auto px-8 lg:px-12 text-center space-y-2">
              <div className="text-[#c07820] text-lg tracking-[0.5em]">&#9670; &#9670; &#9670;</div>
              <p className="text-xs text-[#a09282] mt-3">Shaped by {activeCharacters.join(", ")} · {transcript.filter(e => !(e as any).isOrchestrator && !(e as any).isReaction).length} exchanges</p>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-[#e8e0d5] py-16 text-center bg-white">
            <p className="text-sm text-[#a09282] mb-6">Continue exploring this world using the panel on the right →</p>
            <Link href={`/story/${id}/debate`} className="inline-flex items-center gap-2 px-8 py-3 text-sm font-bold rounded-xl bg-[#c07820] hover:bg-[#a86a18] text-white transition-colors shadow-sm">
              Explore another what-if →
            </Link>
          </div>

          </div>{/* end LEFT column */}

          {/* RIGHT panel — character chat */}
          <div className="w-[380px] shrink-0 border-l border-[#e8e0d5] flex flex-col bg-white">

            {/* Tab bar */}
            <div className="shrink-0 flex border-b border-[#e8e0d5] bg-[#f7f3ed]">
              <button
                onClick={() => setConclusionTab("oracle")}
                className={`flex-1 py-3.5 text-sm font-semibold tracking-wide transition-colors ${conclusionTab === "oracle" ? "text-[#c07820] border-b-2 border-[#c07820]" : "text-[#a09282] hover:text-[#6b5c4e]"}`}
              >◉ Oracle</button>
              <button
                onClick={() => setConclusionTab("story")}
                className={`flex-1 py-3.5 text-sm font-semibold tracking-wide transition-colors ${conclusionTab === "story" ? "text-[#c07820] border-b-2 border-[#c07820]" : "text-[#a09282] hover:text-[#6b5c4e]"}`}
              >✦ Story</button>
            </div>

            {/* Character picker */}
            <div className="shrink-0 px-4 py-3 border-b border-[#e8e0d5] bg-[#faf7f2]">
              <div className="text-xs uppercase tracking-widest text-[#a09282] mb-2">Character</div>
              <div className="flex flex-wrap gap-1.5">
                {activeCharacters.map((name, ci) => {
                  const ccol = CHAR_COLORS[ci % CHAR_COLORS.length].hex;
                  const active = oracleCharacter === name;
                  return (
                    <button key={name}
                      onClick={() => {
                        setOracleCharacter(name);
                        // Do NOT wipe oracleHistory — per-character history
                        // persists across switches for the session.
                        if (conclusionTab === "oracle") { setShowOracle(true); }
                        else { setStoryCharMsgs([]); }
                      }}
                      className="px-3 py-1.5 rounded-full text-sm font-medium transition-all border"
                      style={active
                        ? { background: ccol, color: "#fff", borderColor: ccol }
                        : { background: "white", color: "#6b5c4e", borderColor: "#e8e0d5" }}>
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Oracle chat ── */}
            {conclusionTab === "oracle" && (
              <div className="flex-1 flex flex-col overflow-hidden bg-white">
                {!oracleReady && (
                  <div className="flex-1 flex items-center justify-center px-6 text-center">
                    <p className="text-[#a09282] text-sm">Oracle mode becomes available once the debate concludes.</p>
                  </div>
                )}
                {oracleReady && !oracleCharacter && (
                  <div className="flex-1 flex items-center justify-center px-6 text-center">
                    <p className="text-[#a09282] text-sm">Pick a character above to begin.</p>
                  </div>
                )}
                {oracleReady && oracleCharacter && (
                  <>
                    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-[#faf7f2]">
                      {oracleHistory.length === 0 && (
                        <p className="text-sm text-[#a09282] italic text-center pt-8">
                          Ask {oracleCharacter} anything about their alternate world…
                        </p>
                      )}
                      {oracleHistory.map((msg, i) => (
                        <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
                          {msg.role === "assistant" && (
                            <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
                              style={{ backgroundColor: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>
                              {oracleCharacter[0]}
                            </div>
                          )}
                          <div className={`rounded-xl px-3.5 py-2.5 text-sm max-w-[85%] leading-relaxed ${msg.role === "user" ? "rounded-br-sm font-medium text-white" : "rounded-bl-sm bg-white border border-[#e8e0d5] text-[#1c1410]"}`}
                            style={msg.role === "user" ? { backgroundColor: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex } : {}}>
                            {msg.content}
                          </div>
                        </div>
                      ))}
                      {oracleStreaming && (
                        <div className="flex gap-2">
                          <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
                            style={{ backgroundColor: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>
                            {oracleCharacter[0]}
                          </div>
                          <div className="rounded-xl rounded-bl-sm px-3.5 py-2.5 text-sm bg-white border border-[#e8e0d5] text-[#1c1410] leading-relaxed">
                            {oracleStreaming}<span className="animate-pulse text-[#c07820]">▌</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 px-3 py-3 border-t border-[#e8e0d5] flex gap-2 bg-white">
                      <input
                        value={oracleInput} onChange={e => setOracleInput(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendOracleQuestion()}
                        placeholder={`Ask ${oracleCharacter}…`}
                        className="flex-1 text-sm px-3 py-2.5 rounded-lg border border-[#e8e0d5] focus:outline-none focus:border-[#c07820] bg-[#f7f3ed] text-[#1c1410] placeholder:text-[#c8b89a] transition-colors"
                      />
                      <button onClick={sendOracleQuestion} disabled={oracleLoading || !oracleInput.trim()}
                        className="px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors disabled:opacity-40"
                        style={{ background: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>
                        {oracleLoading ? "…" : "Ask"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Story chat ── */}
            {conclusionTab === "story" && (
              <div className="flex-1 flex flex-col overflow-hidden bg-white">
                {!oracleCharacter && (
                  <div className="flex-1 flex items-center justify-center px-6 text-center">
                    <p className="text-[#a09282] text-sm">Pick a character above to begin.</p>
                  </div>
                )}
                {oracleCharacter && (
                  <>
                    <div className="shrink-0 px-4 py-2.5 border-b border-[#e8e0d5] bg-[#faf7f2]">
                      <p className="text-xs text-[#a09282] italic">
                        {oracleCharacter} · speaking from the original story
                      </p>
                    </div>
                    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-[#faf7f2]">
                      {storyCharMsgs.length === 0 && (
                        <p className="text-sm text-[#a09282] italic text-center pt-8">
                          Ask {oracleCharacter} about their life in the story…
                        </p>
                      )}
                      {storyCharMsgs.map((msg, i) => (
                        <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
                          {msg.role === "assistant" && (
                            <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
                              style={{ backgroundColor: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>
                              {oracleCharacter[0]}
                            </div>
                          )}
                          <div className={`rounded-xl px-3.5 py-2.5 text-sm max-w-[85%] leading-relaxed ${msg.role === "user" ? "rounded-br-sm font-medium text-white" : "rounded-bl-sm bg-white border border-[#e8e0d5] text-[#1c1410]"}`}
                            style={msg.role === "user" ? { backgroundColor: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex } : {}}>
                            {msg.content}
                          </div>
                        </div>
                      ))}
                      {storyCharStreaming && (
                        <div className="flex gap-2">
                          <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
                            style={{ backgroundColor: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>
                            {oracleCharacter[0]}
                          </div>
                          <div className="rounded-xl rounded-bl-sm px-3.5 py-2.5 text-sm bg-white border border-[#e8e0d5] text-[#1c1410] leading-relaxed">
                            {storyCharStreaming}<span className="animate-pulse text-[#c07820]">▌</span>
                          </div>
                        </div>
                      )}
                      <div ref={storyCharEndRef} />
                    </div>
                    <div className="shrink-0 px-3 py-3 border-t border-[#e8e0d5] flex gap-2 bg-white">
                      <input
                        value={storyCharInput} onChange={e => setStoryCharInput(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendStoryChar()}
                        placeholder={`Ask ${oracleCharacter}…`}
                        className="flex-1 text-sm px-3 py-2.5 rounded-lg border border-[#e8e0d5] focus:outline-none focus:border-[#c07820] bg-[#f7f3ed] text-[#1c1410] placeholder:text-[#c8b89a] transition-colors"
                      />
                      <button onClick={sendStoryChar} disabled={storyCharLoading || !storyCharInput.trim()}
                        className="px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors disabled:opacity-40"
                        style={{ background: CHAR_COLORS[activeCharacters.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>
                        {storyCharLoading ? "…" : "Ask"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

          </div>{/* end RIGHT panel */}

          </div>{/* end split body */}
        </div>
      )}
    </main>
  );
}

// Collapsible section for the Ledger panel
function BoruNotesTimeline({ history, latest, phase }: {
  history: { round: number; phase: string; note: string }[];
  latest?: string;
  phase?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Always show the most recent entry. The older ones collapse behind "show all".
  // Fall back to `latest` if history is empty (e.g. snapshot from older debates).
  const entries = history && history.length
    ? history
    : (latest ? [{ round: 0, phase: phase || "", note: latest }] : []);
  if (entries.length === 0) return null;
  const reversed = [...entries].reverse(); // newest first
  const visible = expanded ? reversed : reversed.slice(0, 1);
  return (
    <div className="bg-[#fef9f0] border border-[#f0c060]/30 rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm">🐘</span>
        <span className="text-[10px] text-[#c07820] uppercase tracking-widest font-semibold">
          Boru&apos;s Notes
        </span>
        {phase && (
          <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-[#c07820]/10 text-[#c07820] font-medium">
            {phase.replace(/_/g, " ")}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((e, i) => (
          <div key={`${e.round}-${i}`} className={i === 0 ? "" : "pt-2 border-t border-[#f0c060]/20"}>
            {(e.round > 0 || e.phase) && (
              <div className="flex items-center gap-1.5 text-[9px] text-[#a09282] mb-0.5">
                {e.round > 0 && <span>Round {e.round}</span>}
                {e.phase && e.round > 0 && <span>·</span>}
                {e.phase && <span className="italic">{e.phase.replace(/_/g, " ")}</span>}
              </div>
            )}
            <p className="text-xs text-[#3d2f20] leading-relaxed">{e.note}</p>
          </div>
        ))}
      </div>
      {reversed.length > 1 && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-2 text-[10px] text-[#c07820] hover:text-[#a06010] font-medium transition-colors"
        >
          {expanded ? "Show latest only" : `Show all ${reversed.length} notes`}
        </button>
      )}
    </div>
  );
}

function LedgerSection({ title, count, badge, defaultOpen, empty, children }: {
  title: string; count: number; badge?: React.ReactNode; defaultOpen: boolean;
  empty: string; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-[#e8e0d5] rounded-xl overflow-hidden bg-white">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#f7f3ed] transition-colors text-left">
        <span className="text-[10px] text-[#a09282] uppercase tracking-widest font-semibold">{title}</span>
        {count > 0 && <span className="text-[10px] bg-[#f0ebe4] text-[#6b5c4e] px-1.5 py-0.5 rounded-full font-medium">{count}</span>}
        {badge && <span className="text-[10px] ml-auto">{badge}</span>}
        <span className={`text-[#c8b89a] text-xs transition-transform ${open ? "" : "-rotate-90"}`}>▾</span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          {count === 0 && empty ? (
            <p className="text-xs text-[#c8b89a] italic py-2 px-1">{empty}</p>
          ) : children}
        </div>
      )}
    </div>
  );
}
