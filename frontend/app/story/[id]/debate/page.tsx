"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

const API = "http://localhost:8001";

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

type DebateEntry = { character: string; message: string; round: number; target?: string; emotion?: string; judgeScore?: number; isExploration?: boolean; isObserver?: boolean; observerEra?: string; };
type StreamEntry = { character: string; text: string; };
type DivPoint    = { event_id: string; description: string; affected_characters: string[]; };

type GraphNode = { id: string; x: number; y: number; vx: number; vy: number; r: number; color: string; speeches: number; };
type GraphEdge = { source: string; target: string; count: number; questions: number; };

export default function DebatePage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [divergence, setDivergence] = useState(() => searchParams.get("q") || "");
  const [storyTitle, setStoryTitle] = useState("");
  const [suggestions, setSuggestions] = useState<DivPoint[]>([]);
  const [transcript, setTranscript] = useState<DebateEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamEntry | null>(null);
  const [alternateEnding, setAlternateEnding] = useState("");
  const [streamingEnding, setStreamingEnding] = useState("");
  const [alternateTimeline, setAlternateTimeline] = useState<any[]>([]);
  const [showConclusion, setShowConclusion] = useState(false);
  const [oracleReady, setOracleReady] = useState(false);
  const [showOracle, setShowOracle] = useState(false);
  const [oracleCharacter, setOracleCharacter] = useState("");
  // Conclusion panel
  const [conclusionTab, setConclusionTab] = useState<"oracle"|"story">("oracle");
  const [storyCharMsgs, setStoryCharMsgs] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [storyCharStreaming, setStoryCharStreaming] = useState("");
  const [storyCharLoading, setStoryCharLoading] = useState(false);
  const [storyCharInput, setStoryCharInput] = useState("");
  const storyCharEndRef = useRef<HTMLDivElement>(null);
  const [oracleInput, setOracleInput] = useState("");
  const [oracleHistory, setOracleHistory] = useState<{role:string;content:string;character?:string}[]>([]);
  const [oracleStreaming, setOracleStreaming] = useState("");
  const [oracleLoading, setOracleLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "done">("idle");
  const [dramaScore, setDramaScore] = useState(0.5);
  const [activeCharacters, setActiveCharacters] = useState<string[]>([]);
  const [storyCharacters, setStoryCharacters] = useState<{name:string;role?:string;importance:number}[]>([]);
  const [selectedCharacters, setSelectedCharacters] = useState<Set<string>>(new Set());
  const [explorationRates, setExplorationRates] = useState<Record<string,number>>({});
  const [pendingChallenge, setPendingChallenge] = useState<{character: string; observerName: string; question: string} | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [leftTab, setLeftTab] = useState<"debate"|"agents"|"chat">("debate");
  const [showGraph, setShowGraph] = useState(true);
  const [activeTab, setActiveTab] = useState<"graph"|"heatmap"|"emotions">("graph");
  const [showStats, setShowStats] = useState(true);
  const [heatmapLegendOpen, setHeatmapLegendOpen] = useState(false);
  const [emotionLegendOpen, setEmotionLegendOpen] = useState(false);
  const [graphLegendCollapsed, setGraphLegendCollapsed] = useState(false);
  const [graphLegendPos, setGraphLegendPos] = useState({ x: 12, y: -1 }); // -1 y = anchor to bottom
  const graphLegendDragRef = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });
  const [splitPct, setSplitPct] = useState(42);
  const pendingExplorationRef = useRef<string | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const [chatMessages, setChatMessages] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [chatLoading, setChatLoading]   = useState(false);
  const [debateId, setDebateId]         = useState<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Interaction graph
  const graphCanvasRef      = useRef<HTMLCanvasElement>(null);
  const graphNodesRef       = useRef<GraphNode[]>([]);
  const graphEdgesRef       = useRef<GraphEdge[]>([]);
  const graphAnimRef        = useRef<number>(0);
  const activeNodeRef       = useRef<string | null>(null); // currently speaking
  const zoomRef             = useRef(1);
  const panRef              = useRef({ x: 0, y: 0 });
  const graphDragRef        = useRef({ active: false, sx: 0, sy: 0, px: 0, py: 0 });
  const physicsSettledRef   = useRef(false);
  const heatmapCanvasRef    = useRef<HTMLCanvasElement>(null);
  const emotionsCanvasRef   = useRef<HTMLCanvasElement>(null);
  const [graphStats, setGraphStats] = useState<{id: string; color: string; speeches: number}[]>([]);
  const [graphHover, setGraphHover] = useState<{ x: number; y: number; source: string; target: string; count: number; questions: number; snippet: string } | null>(null);
  const transcriptRef = useRef<DebateEntry[]>([]);

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

  useEffect(() => {
    transcriptRef.current = transcript;
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript, streaming]);

  // Resizable split drag
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => { isDraggingRef.current = false; setIsDraggingSplit(false); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const colorOf = (name: string) => CHAR_COLORS[activeCharacters.indexOf(name) % CHAR_COLORS.length] || CHAR_COLORS[0];
  const initials = (name: string) => name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

  // Sync transcript → graph nodes + edges
  useEffect(() => {
    if (transcript.length === 0) return;
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const W = canvas.width || 400, H = canvas.height || 500;

    const ensureNode = (name: string) => {
      let node = graphNodesRef.current.find(n => n.id === name);
      if (!node) {
        const idx = activeCharacters.indexOf(name);
        const hex = (CHAR_COLORS[idx % CHAR_COLORS.length] || CHAR_COLORS[0]).hex;
        // Arrange initially in a circle
        const total = activeCharacters.length || 1;
        const angle = (activeCharacters.indexOf(name) / total) * 2 * Math.PI;
        const dist = Math.min(W, H) * 0.3;
        node = {
          id: name,
          x: W / 2 + Math.cos(angle) * dist + (Math.random() - 0.5) * 30,
          y: H / 2 + Math.sin(angle) * dist + (Math.random() - 0.5) * 30,
          vx: 0, vy: 0, r: 18, color: hex, speeches: 0,
        };
        graphNodesRef.current.push(node);
      }
      return node;
    };

    const last = transcript[transcript.length - 1];
    const lastNode = ensureNode(last.character);
    lastNode.speeches++;
    lastNode.r = Math.min(18 + lastNode.speeches * 1.5, 34);
    activeNodeRef.current = null;
    physicsSettledRef.current = false; // wake physics for new node
    // Update stats for React render
    setGraphStats(graphNodesRef.current.map(n => ({ id: n.id, color: n.color, speeches: n.speeches })));

    // Use target_character from backend if available, else previous speaker
    const targetName = last.target || (transcript.length >= 2 ? transcript[transcript.length - 2].character : null);
    if (targetName && targetName !== last.character) {
      ensureNode(targetName);
      const isQuestion = last.message.includes("?");
      const existing = graphEdgesRef.current.find(
        e => e.source === last.character && e.target === targetName
      );
      if (existing) {
        existing.count++;
        if (isQuestion) existing.questions++;
      } else {
        graphEdgesRef.current.push({ source: last.character, target: targetName, count: 1, questions: isQuestion ? 1 : 0 });
      }
    }
  }, [transcript, activeCharacters]);

  // Track streaming speaker
  useEffect(() => {
    activeNodeRef.current = streaming?.character ?? null;
  }, [streaming]);

  // Graph physics + render loop
  useEffect(() => {
    if (status !== "running" && status !== "done") return;
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;

    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener("resize", resize);

    // Zoom on wheel (pivot at mouse)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.85 : 1 / 0.85;
      const newZoom = Math.max(0.25, Math.min(4, zoomRef.current * factor));
      panRef.current.x = mx - (mx - panRef.current.x) * (newZoom / zoomRef.current);
      panRef.current.y = my - (my - panRef.current.y) * (newZoom / zoomRef.current);
      zoomRef.current = newZoom;
    };
    // Drag-to-pan
    const onCanvasDown = (e: MouseEvent) => {
      graphDragRef.current = { active: true, sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y };
      canvas.style.cursor = "grabbing";
    };
    const onDragMove = (e: MouseEvent) => {
      if (!graphDragRef.current.active) return;
      panRef.current.x = graphDragRef.current.px + (e.clientX - graphDragRef.current.sx);
      panRef.current.y = graphDragRef.current.py + (e.clientY - graphDragRef.current.sy);
    };
    const onDragUp = () => { graphDragRef.current.active = false; canvas.style.cursor = "grab"; };

    // Hover detection — find which edge the mouse is near
    const onCanvasMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      // Convert screen coords → world coords
      const mx = (e.clientX - rect.left - panRef.current.x) / zoomRef.current;
      const my = (e.clientY - rect.top  - panRef.current.y) / zoomRef.current;

      const nodes = graphNodesRef.current;
      const edges = graphEdgesRef.current;
      let hit: typeof graphHover = null;

      for (const edge of edges) {
        const src = nodes.find(n => n.id === edge.source);
        const tgt = nodes.find(n => n.id === edge.target);
        if (!src || !tgt) continue;

        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const ux = dx/d, uy = dy/d;
        const px = -uy, py = ux;
        const hasMirror = edges.some(e2 => e2.source === edge.target && e2.target === edge.source);
        const baseCurve = hasMirror ? 32 : 18;
        const cpX = (src.x + tgt.x) / 2 + px * baseCurve;
        const cpY = (src.y + tgt.y) / 2 + py * baseCurve;

        // Sample bezier at 12 points and find min distance to mouse
        let minDist = Infinity;
        for (let t = 0; t <= 1; t += 1/12) {
          const bx = (1-t)*(1-t)*src.x + 2*(1-t)*t*cpX + t*t*tgt.x;
          const by = (1-t)*(1-t)*src.y + 2*(1-t)*t*cpY + t*t*tgt.y;
          const dist = Math.sqrt((mx-bx)**2 + (my-by)**2);
          if (dist < minDist) minDist = dist;
        }

        if (minDist < 12) {
          // Find the most recent message in this direction from the current transcript
          const msgs = transcriptRef.current.filter(
            e => e.character === edge.source && e.target === edge.target
          );
          const last = msgs[msgs.length - 1];
          const snippet = last ? last.message.slice(0, 120).trimEnd() + (last.message.length > 120 ? "…" : "") : "";
          hit = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            source: edge.source,
            target: edge.target,
            count: edge.count,
            questions: edge.questions,
            snippet,
          };
          break;
        }
      }
      setGraphHover(hit);
    };
    const onCanvasLeave = () => setGraphHover(null);

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onCanvasDown);
    canvas.addEventListener("mousemove", onCanvasMove);
    canvas.addEventListener("mouseleave", onCanvasLeave);
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragUp);

    const drawArrow = (ctx: CanvasRenderingContext2D, tx: number, ty: number, ux: number, uy: number, size: number) => {
      const ax = tx - ux*size - uy*(size*0.6);
      const ay = ty - uy*size + ux*(size*0.6);
      const bx = tx - ux*size + uy*(size*0.6);
      const by = ty - uy*size - ux*(size*0.6);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ax, ay); ctx.lineTo(bx, by); ctx.closePath(); ctx.fill();
    };

    const tick = () => {
      frame++;
      const nodes = graphNodesRef.current;
      const edges = graphEdgesRef.current;
      const W = canvas.width, H = canvas.height;
      const cx = W / 2, cy = H / 2;

      // Physics (skip when settled)
      if (!physicsSettledRef.current) {
        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
            const d2 = dx*dx + dy*dy + 1;
            const f = 1800 / d2;
            nodes[i].vx -= dx*f; nodes[i].vy -= dy*f;
            nodes[j].vx += dx*f; nodes[j].vy += dy*f;
          }
        }
        // Springs
        for (const e of edges) {
          const src = nodes.find(n => n.id === e.source);
          const tgt = nodes.find(n => n.id === e.target);
          if (!src || !tgt) continue;
          const dx = tgt.x - src.x, dy = tgt.y - src.y;
          const d = Math.sqrt(dx*dx + dy*dy) || 1;
          const ideal = 110 + src.r + tgt.r;
          const f = (d - ideal) * 0.025;
          src.vx += (dx/d)*f; src.vy += (dy/d)*f;
          tgt.vx -= (dx/d)*f; tgt.vy -= (dy/d)*f;
        }
        // Gravity + damping + bounds
        let maxV = 0;
        for (const n of nodes) {
          n.vx += (cx - n.x) * 0.008; n.vy += (cy - n.y) * 0.008;
          n.vx *= 0.85; n.vy *= 0.85;
          n.x += n.vx; n.y += n.vy;
          n.x = Math.max(n.r + 12, Math.min(W - n.r - 12, n.x));
          n.y = Math.max(n.r + 12, Math.min(H - n.r - 12, n.y));
          maxV = Math.max(maxV, Math.abs(n.vx), Math.abs(n.vy));
        }
        if (frame > 120 && maxV < 0.15) physicsSettledRef.current = true;
      }

      // ── Draw ──
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#f7f3ed"; ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(panRef.current.x, panRef.current.y);
      ctx.scale(zoomRef.current, zoomRef.current);

      // Edges — draw as a bundle of curved strands (one per interaction)
      for (const e of edges) {
        const src = nodes.find(n => n.id === e.source);
        const tgt = nodes.find(n => n.id === e.target);
        if (!src || !tgt) continue;

        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const ux = dx/d, uy = dy/d;
        const px = -uy, py = ux; // perp unit vector

        const isQ = e.questions > 0;
        const col = isQ ? "#f0c060" : src.color;
        const strandCount = e.count;
        // Keep bundle width ≤ 28px regardless of count
        const spacing = strandCount > 1 ? Math.min(3.5, 28 / (strandCount - 1)) : 0;

        // Curve only when bidirectional — otherwise straight line
        const hasMirror = edges.some(e2 => e2.source === e.target && e2.target === e.source);
        const baseCurve = hasMirror ? 32 : 0;

        for (let si = 0; si < strandCount; si++) {
          const strandOff = (si - (strandCount - 1) / 2) * spacing;
          const curveOff = baseCurve + strandOff * 0.6;
          const offX = px * (strandOff + curveOff), offY = py * (strandOff + curveOff);
          const cpX = (src.x + tgt.x) / 2 + offX, cpY = (src.y + tgt.y) / 2 + offY;

          const sxe = src.x + ux * src.r + px * strandOff * 0.4;
          const sye = src.y + uy * src.r + py * strandOff * 0.4;
          const txe = tgt.x - ux * tgt.r + px * strandOff * 0.4;
          const tye = tgt.y - uy * tgt.r + py * strandOff * 0.4;

          // Centre strand is brightest; outer strands fade
          const edgeFade = strandCount === 1 ? 1 : 1 - Math.abs(si - (strandCount - 1) / 2) / (strandCount * 0.8);
          // First interaction is bolder so it's always visible
          const baseAlpha = strandCount === 1 ? 0.85 : 0.6;
          const alpha = Math.min(baseAlpha + edgeFade * 0.3, 0.95);
          // First strand slightly thicker to ensure visibility
          const lineW = strandCount === 1 ? 1.8 : 1.2;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(sxe, sye);
          ctx.quadraticCurveTo(cpX, cpY, txe, tye);
          ctx.strokeStyle = col + Math.round(alpha * 255).toString(16).padStart(2, "0");
          ctx.lineWidth = lineW;
          ctx.stroke();
          ctx.restore();
        }

        // Arrowhead on the central strand
        const cpX0 = (src.x + tgt.x) / 2 + px * baseCurve;
        const cpY0 = (src.y + tgt.y) / 2 + py * baseCurve;
        const txe0 = tgt.x - ux * tgt.r;
        const tye0 = tgt.y - uy * tgt.r;
        const arrowDx = txe0 - cpX0, arrowDy = tye0 - cpY0;
        const arrowD = Math.sqrt(arrowDx*arrowDx + arrowDy*arrowDy) || 1;
        ctx.fillStyle = col + "dd";
        drawArrow(ctx, txe0, tye0, arrowDx/arrowD, arrowDy/arrowD, 8);

        // Edge label at the curve midpoint
        // Bezier midpoint at t=0.5: B(0.5) = 0.25*start + 0.5*cp + 0.25*end
        const sxe0 = src.x + ux * src.r;
        const sye0 = src.y + uy * src.r;
        const labelX = 0.25 * sxe0 + 0.5 * cpX0 + 0.25 * txe0;
        const labelY = 0.25 * sye0 + 0.5 * cpY0 + 0.25 * tye0;
        const labelText = isQ
          ? (e.questions === 1 ? "asked" : `${e.questions} Qs`)
          : (e.count === 1 ? "spoke to" : `${e.count}×`);
        ctx.save();
        ctx.font = "bold 9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Pill background
        const tw = ctx.measureText(labelText).width;
        const ph = 10, pw = tw + 8;
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.beginPath();
        ctx.roundRect(labelX - pw/2, labelY - ph/2, pw, ph, 3);
        ctx.fill();
        ctx.strokeStyle = col + "44";
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.fillStyle = col + "ee";
        ctx.fillText(labelText, labelX, labelY);
        ctx.restore();
      }

      // Nodes
      const active = activeNodeRef.current;
      const pulse = Math.sin(frame * 0.08) * 0.5 + 0.5; // 0..1

      for (const n of nodes) {
        const isActive = n.id === active;

        // Glow
        const glowR = n.r * (isActive ? 2.8 + pulse * 0.8 : 2);
        const grd = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, glowR);
        grd.addColorStop(0, n.color + (isActive ? "44" : "22"));
        grd.addColorStop(1, "transparent");
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, 2*Math.PI);
        ctx.fillStyle = grd; ctx.fill();

        // Shadow
        ctx.beginPath(); ctx.arc(n.x + 2, n.y + 3, n.r, 0, 2*Math.PI);
        ctx.fillStyle = "rgba(0,0,0,0.08)"; ctx.fill();

        // Circle
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 2*Math.PI);
        ctx.fillStyle = n.color; ctx.fill();

        // Expanding rings for active speaker
        if (isActive) {
          // Inner ring
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + pulse * 3, 0, 2*Math.PI);
          ctx.strokeStyle = n.color + "cc"; ctx.lineWidth = 2; ctx.stroke();
          // Outer expanding ring
          const outerR = n.r + 8 + pulse * 10;
          ctx.beginPath(); ctx.arc(n.x, n.y, outerR, 0, 2*Math.PI);
          ctx.strokeStyle = n.color + Math.round((1 - pulse) * 100).toString(16).padStart(2,"0");
          ctx.lineWidth = 1.5; ctx.stroke();
          // "speaking" label above node
          ctx.font = "bold 8px Inter, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillStyle = n.color + "cc";
          ctx.fillText("speaking", n.x, n.y - n.r - 8);
        }

        // Initials
        const fontSize = Math.max(10, Math.min(13, n.r * 0.65));
        ctx.font = `bold ${fontSize}px Inter, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillText(n.id.split(" ").map((w:string) => w[0]).join("").slice(0,2).toUpperCase(), n.x, n.y);

        // Name label below node
        const name = n.id.split(" ").slice(0, 2).join(" ");
        ctx.font = `600 ${Math.max(9, Math.min(11, n.r * 0.5))}px Inter, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillStyle = isActive ? "#3d2f20" : "#8a7260";
        ctx.fillText(name, n.x, n.y + n.r + 4);

        // Speech count badge
        if (n.speeches > 0) {
          const bx = n.x + n.r * 0.7, by = n.y - n.r * 0.7;
          ctx.beginPath(); ctx.arc(bx, by, 7, 0, 2*Math.PI);
          ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
          ctx.strokeStyle = n.color + "88"; ctx.lineWidth = 1.2; ctx.stroke();
          ctx.font = "bold 7px Inter, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = n.color;
          ctx.fillText(String(n.speeches), bx, by);
        }
      }

      ctx.restore();

      if (nodes.length === 0) {
        ctx.font = "13px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#c8b89a";
        ctx.fillText("Waiting for debate to begin…", W/2, H/2);
      }

      graphAnimRef.current = requestAnimationFrame(tick);
    };

    graphAnimRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(graphAnimRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onCanvasDown);
      canvas.removeEventListener("mousemove", onCanvasMove);
      canvas.removeEventListener("mouseleave", onCanvasLeave);
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragUp);
    };
  }, [status]);

  // ── Heatmap: redraw whenever transcript or active tab changes ──
  useEffect(() => {
    const canvas = heatmapCanvasRef.current;
    if (!canvas || activeCharacters.length === 0) return;
    canvas.width = canvas.offsetWidth || 400;
    canvas.height = canvas.offsetHeight || 400;
    const ctx = canvas.getContext("2d")!;
    const chars = activeCharacters;
    const N = chars.length;
    const W = canvas.width, H = canvas.height;

    ctx.fillStyle = "#f7f3ed"; ctx.fillRect(0, 0, W, H);
    if (transcript.length === 0) {
      ctx.font = "13px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#c8b89a";
      ctx.fillText("Waiting for debate to begin…", W/2, H/2);
      return;
    }

    const counts: number[][] = Array.from({length: N}, () => Array(N).fill(0));
    let maxCount = 0;
    for (const entry of transcript) {
      const i = chars.indexOf(entry.character);
      const j = entry.target ? chars.indexOf(entry.target) : -1;
      if (i >= 0 && j >= 0 && i !== j) { counts[i][j]++; maxCount = Math.max(maxCount, counts[i][j]); }
    }

    // Compute a centered square grid with equal visual margins
    const labelW = Math.min(W * 0.18, 72);   // left: row-label space
    const labelH = Math.min(H * 0.18, 60);   // top: rotated col-label space
    const padR = 16, padB = 16;
    const availW = W - labelW - padR;
    const availH = H - labelH - padB;
    const cellSize = Math.min(availW / N, availH / N, 76);
    const gridW = cellSize * N, gridH = cellSize * N;
    const gridLeft = labelW + (availW - gridW) / 2;
    const gridTop  = labelH + (availH - gridH) / 2;

    const fontSize = Math.min(12, Math.max(9, cellSize * 0.36));

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = gridLeft + j * cellSize, y = gridTop + i * cellSize;
        const intensity = maxCount > 0 ? counts[i][j] / maxCount : 0;
        if (i === j) {
          ctx.fillStyle = "rgba(200,184,154,0.15)";
          ctx.fillRect(x + 1, y + 1, cellSize - 3, cellSize - 3);
          // Diagonal marker
          ctx.strokeStyle = "rgba(200,184,154,0.3)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x+4, y+4); ctx.lineTo(x+cellSize-5, y+cellSize-5); ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${Math.round(192*intensity+230*(1-intensity))},${Math.round(80*intensity+180*(1-intensity))},${Math.round(10*intensity+140*(1-intensity))},${0.12 + intensity * 0.75})`;
          ctx.fillRect(x + 1, y + 1, cellSize - 3, cellSize - 3);
          if (counts[i][j] > 0) {
            ctx.font = `bold ${Math.max(9, cellSize * 0.32)}px Inter, sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = intensity > 0.5 ? "#ffffff" : "#3d2f20";
            ctx.fillText(String(counts[i][j]), x + cellSize/2, y + cellSize/2);
          }
        }
      }
    }

    // Grid lines
    ctx.strokeStyle = "rgba(200,184,154,0.5)"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= N; i++) {
      ctx.beginPath(); ctx.moveTo(gridLeft + i * cellSize, gridTop); ctx.lineTo(gridLeft + i * cellSize, gridTop + gridH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(gridLeft, gridTop + i * cellSize); ctx.lineTo(gridLeft + gridW, gridTop + i * cellSize); ctx.stroke();
    }

    // Row labels (speaker = who said it)
    for (let i = 0; i < N; i++) {
      ctx.font = `600 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillStyle = (CHAR_COLORS[i % CHAR_COLORS.length]).hex;
      ctx.fillText(chars[i].split(" ")[0], gridLeft - 8, gridTop + i * cellSize + cellSize/2);
    }
    // Column labels (target = spoken to), rotated
    for (let j = 0; j < N; j++) {
      ctx.save();
      ctx.translate(gridLeft + j * cellSize + cellSize/2, gridTop - 8);
      ctx.rotate(-Math.PI / 4);
      ctx.font = `600 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillStyle = (CHAR_COLORS[j % CHAR_COLORS.length]).hex;
      ctx.fillText(chars[j].split(" ")[0], 0, 0);
      ctx.restore();
    }

    // Axis header labels
    ctx.font = `500 ${fontSize - 1}px Inter, sans-serif`;
    ctx.fillStyle = "#a09282";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("spoken to →", gridLeft + gridW / 2, gridTop - labelH * 0.05);
    ctx.save();
    ctx.translate(gridLeft - labelW * 0.55, gridTop + gridH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("speaker ↓", 0, 0);
    ctx.restore();
  }, [transcript, activeCharacters, activeTab]);

  // ── Emotions arc: redraw whenever transcript or active tab changes ──
  useEffect(() => {
    const canvas = emotionsCanvasRef.current;
    if (!canvas || activeCharacters.length === 0) return;
    canvas.width = canvas.offsetWidth || 400;
    canvas.height = canvas.offsetHeight || 400;
    const ctx = canvas.getContext("2d")!;
    const chars = activeCharacters;
    const W = canvas.width, H = canvas.height;

    ctx.fillStyle = "#f7f3ed"; ctx.fillRect(0, 0, W, H);
    if (transcript.length === 0) {
      ctx.font = "13px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#c8b89a";
      ctx.fillText("Waiting for debate to begin…", W/2, H/2);
      return;
    }

    const padL = 76, padR = 16, padT = 20, padB = 28;
    const rowH = (H - padT - padB) / chars.length;
    const totalTurns = transcript.length;
    const xOf = (idx: number) => padL + (totalTurns <= 1 ? 0.5 : idx / (totalTurns - 1)) * (W - padL - padR);

    for (let ci = 0; ci < chars.length; ci++) {
      const charName = chars[ci];
      const color = CHAR_COLORS[ci % CHAR_COLORS.length].hex;
      const y = padT + ci * rowH + rowH / 2;

      // Lane background (alternating subtle stripe)
      if (ci % 2 === 0) {
        ctx.fillStyle = "rgba(200,184,154,0.08)";
        ctx.fillRect(padL, padT + ci * rowH, W - padL - padR, rowH);
      }

      // Lane separator
      ctx.strokeStyle = "rgba(200,184,154,0.3)"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(padL, padT + ci * rowH); ctx.lineTo(W - padR, padT + ci * rowH); ctx.stroke();

      // Character label
      ctx.font = `600 11px Inter, sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(charName.split(" ")[0], padL - 8, y);

      const turns = transcript.map((e, idx) => ({ ...e, idx })).filter(e => e.character === charName);
      if (turns.length === 0) continue;

      // Connecting line — solid, subtle
      ctx.strokeStyle = color + "40"; ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      turns.forEach((t, ti) => { const x = xOf(t.idx); ti === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();

      // Dots
      for (const turn of turns) {
        const x = xOf(turn.idx);
        const em = EMOTION_STYLE[turn.emotion || "neutral"] || EMOTION_STYLE.neutral;
        // Soft glow on light background
        const grd = ctx.createRadialGradient(x, y, 1, x, y, 9);
        grd.addColorStop(0, em.dot + "55"); grd.addColorStop(1, "transparent");
        ctx.beginPath(); ctx.arc(x, y, 9, 0, 2*Math.PI); ctx.fillStyle = grd; ctx.fill();
        // Dot (exploration turns get a diamond shape)
        if (turn.isExploration) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI/4);
          ctx.fillStyle = em.dot;
          ctx.fillRect(-5, -5, 10, 10);
          ctx.restore();
          ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillStyle = "#c07820cc";
          ctx.fillText("✦", x, y - 7);
        } else {
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 2*Math.PI);
          ctx.fillStyle = em.dot; ctx.fill();
          // White ring for visibility on light bg
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 2*Math.PI);
          ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.5; ctx.stroke();
        }
        // Emotion label if space allows
        if (em.label && W / Math.max(totalTurns, 1) > 36) {
          ctx.font = "8px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
          ctx.fillStyle = em.dot + "bb";
          ctx.fillText(em.label, x, y + 8);
        }
      }
    }

    // Bottom lane border
    ctx.strokeStyle = "rgba(200,184,154,0.3)"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(padL, padT + chars.length * rowH); ctx.lineTo(W - padR, padT + chars.length * rowH); ctx.stroke();

    // Turn axis tick marks + numbers
    ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = "#a09282";
    const step = Math.max(1, Math.floor(totalTurns / 8));
    for (let i = 0; i < totalTurns; i += step) {
      const tx = xOf(i);
      ctx.strokeStyle = "rgba(200,184,154,0.4)"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(tx, padT); ctx.lineTo(tx, padT + chars.length * rowH); ctx.stroke();
      ctx.fillText(String(i + 1), tx, padT + chars.length * rowH + 4);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillStyle = "#c8b89a";
    ctx.fillText("turn →", padL + (W - padL - padR) / 2, H - 2);
  }, [transcript, activeCharacters, activeTab]);

  const startDebate = async () => {
    if (!divergence.trim()) return;
    setStatus("starting");
    graphNodesRef.current = [];
    graphEdgesRef.current = [];
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
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
    setActiveCharacters(data.characters);
    setStatus("running");

    const es = new EventSource(`${API}/debates/${data.debate_id}/stream`);
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
        setTranscript(prev => [...prev, {
          character: ev.character,
          message: ev.message,
          round: ev.round || 0,
          target: ev.target_character || undefined,
          emotion: ev.emotion || "neutral",
          judgeScore: typeof ev.judge_score === "number" ? ev.judge_score : undefined,
          isExploration,
        }]);
        setStreaming(null);
      } else if (ev.type === "ending_token") {
        setStreamingEnding(prev => prev + ev.text);
      } else if (ev.type === "debate_end") {
        setAlternateEnding(ev.alternate_ending);
        setAlternateTimeline(ev.alternate_timeline || []);
        setStreamingEnding("");
        setStatus("done");
        if (ev.oracle_ready) setOracleReady(true);
        setTimeout(() => setShowConclusion(true), 800);
        es.close();
      } else if (ev.type === "interrogator_start") {
        setStreaming({ character: "The Interrogator", text: "" });
      } else if (ev.type === "interrogator_token") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + ev.text } : null);
      } else if (ev.type === "interrogator_end") {
        setTranscript(prev => [...prev, {
          character: "The Interrogator",
          message: ev.message,
          round: 0,
          isObserver: true,
          observerEra: "structural voice",
        }]);
        setStreaming(null);
      } else if (ev.type === "observer_challenge") {
        setPendingChallenge({ character: ev.character, observerName: ev.observer_name, question: ev.question });
      } else if (ev.type === "observer_start") {
        setStreaming({ character: ev.observer_name, text: "" });
      } else if (ev.type === "observer_token") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + ev.text } : null);
      } else if (ev.type === "observer_end") {
        setTranscript(prev => [...prev, {
          character: ev.observer_name,
          message: ev.message,
          round: 0,
          isObserver: true,
          observerEra: ev.era || "",
        }]);
        setStreaming(null);
      } else if (ev.type === "turn_error") {
        // One turn failed — debate continues, just log it silently
        setStreaming(null);
      }
    };
    es.onerror = () => {
      es.close();
      setStreaming(null);
      setStatus(prev => prev === "running" ? "done" : prev);
    };
  };

  const sendOracleQuestion = async () => {
    const q = oracleInput.trim();
    if (!q || oracleLoading || !debateId || !oracleCharacter) return;
    setOracleInput("");
    setOracleHistory(prev => [...prev, { role: "user", content: q }]);
    setOracleLoading(true);
    setOracleStreaming("");
    try {
      const res = await fetch(`${API}/debates/${debateId}/oracle/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_name: oracleCharacter, question: q, history: oracleHistory }),
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
              setOracleHistory(prev => [...prev, { role: "assistant", content: full || "…", character: oracleCharacter }]);
              setOracleStreaming("");
              gotDone = true;
            }
          } catch {}
        }
      }
      // Stream closed without a done event (network cut / server error)
      if (!gotDone) {
        setOracleHistory(prev => [...prev, { role: "assistant", content: full || "The oracle could not reach this character right now.", character: oracleCharacter }]);
        setOracleStreaming("");
      }
    } catch {
      setOracleHistory(prev => [...prev, { role: "assistant", content: "The oracle could not reach this character right now.", character: oracleCharacter }]);
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
          } catch {}
        }
      }
      if (!gotDone) { setStoryCharMsgs(prev => [...prev, { role: "assistant", content: full || "Could not reach this character." }]); setStoryCharStreaming(""); }
    } catch {
      setStoryCharMsgs(prev => [...prev, { role: "assistant", content: "Could not reach this character right now." }]);
      setStoryCharStreaming("");
    } finally { setStoryCharLoading(false); }
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
      <main className="flex-1 flex flex-col bg-[#f7f3ed] overflow-y-auto">
        {/* Top bar */}
        <div className="bg-white border-b border-[#e8e0d5] shrink-0">
          <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
            <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors flex items-center gap-1.5">
              ← {storyTitle || "Back"}
            </Link>
            <div className="text-xs font-semibold tracking-[0.2em] text-[#c07820] uppercase">Sabha · The Great Debate</div>
          </div>
        </div>

        <div className="flex-1 flex flex-col max-w-5xl mx-auto w-full px-6 py-10 gap-8">

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

              {/* Suggestions */}
              {suggestions.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-[#a09282] uppercase tracking-widest mb-2">Story suggests</div>
                  {suggestions.map((s) => {
                    const active = divergence === s.description;
                    return (
                      <button
                        key={s.event_id}
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
                                  <span key={c} className="text-xs px-2 py-0.5 rounded-full font-medium"
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
                  <div className="flex items-center gap-3 pt-1">
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                    <span className="text-xs text-[#c8b89a]">or write your own</span>
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                  </div>
                </div>
              )}

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
                      <><span>⚡</span> Begin Sabha</>
                    )}
                  </button>
                </div>
              </div>

              {/* How it works — subtle hint */}
              <div className="flex items-start gap-3 px-1">
                <div className="shrink-0 w-5 h-5 rounded-full bg-[#f0ece5] border border-[#e8e0d5] flex items-center justify-center mt-0.5">
                  <span className="text-[#a09282] text-xs">?</span>
                </div>
                <p className="text-xs text-[#a09282] leading-relaxed">
                  Characters will argue, question, and reveal hidden depths across multiple rounds. A judge scores each turn. When the debate concludes, an alternate ending is written.
                </p>
              </div>
            </div>

            {/* ── SECTION 2: The Cast ── */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-[#3d2f20] text-white text-xs font-bold flex items-center justify-center shrink-0">2</div>
                <div>
                  <div className="text-base font-bold text-[#1c1410]">Assemble the Cast</div>
                  <div className="text-xs text-[#a09282]">Choose who debates and tune their depth</div>
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
                    {storyCharacters.map((char) => {
                      const rate = explorationRates[char.name] ?? 10;
                      const color = CHAR_COLORS[storyCharacters.indexOf(char) % CHAR_COLORS.length];
                      const selected = selectedCharacters.has(char.name);
                      return (
                        <div key={char.name}
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
                            {/* Exploration badge */}
                            {selected && (
                              <div className="shrink-0 text-right">
                                <div className="text-sm font-bold tabular-nums" style={{ color: rate > 25 ? color.hex : "#c8b89a" }}>{rate}%</div>
                                <div className="text-[10px] text-[#c8b89a] leading-none">depth</div>
                              </div>
                            )}
                          </div>

                          {/* Slider row — only when selected */}
                          {selected && (
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

                  {/* Depth explainer */}
                  <div className="flex items-start gap-3 px-1">
                    <div className="shrink-0 w-5 h-5 rounded-full bg-[#f0ece5] border border-[#e8e0d5] flex items-center justify-center mt-0.5">
                      <span className="text-[#a09282] text-xs">?</span>
                    </div>
                    <p className="text-xs text-[#a09282] leading-relaxed">
                      <span className="font-semibold text-[#6b5c4e]">Hidden depth</span> controls how often a character breaks from their expected position and reveals something surprising — a buried fear, a secret loyalty, or an unexpected argument.
                    </p>
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
              <span className="flex gap-0.5 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-[#c07820] animate-pulse" />
                <span className="text-xs text-[#c07820] font-semibold uppercase tracking-wide">Live</span>
              </span>
            )}
            {status === "done" && (
              <span className="text-xs text-emerald-600 font-semibold uppercase tracking-wide flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Concluded
              </span>
            )}
          </div>
        </div>

        {/* Question + controls row */}
        <div className="px-5 pb-2 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#1c1410] truncate leading-tight">
              <span className="text-[#c07820] mr-1.5 font-bold text-xs">What if…</span>
              {divergence || "—"}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {/* Debate stats — only show once debate has started */}
            {transcript.length > 0 && (() => {
              const N = Math.max(activeCharacters.length, 1);
              const lastTurn = transcript[transcript.length - 1]?.round ?? 0;
              const currentRound = Math.floor(lastTurn / N) + 1;
              const topSpeaker = [...graphStats].sort((a, b) => b.speeches - a.speeches)[0];
              return (
                <div className="flex items-center gap-2 text-xs text-[#a09282]">
                  <span title="Total exchanges" className="flex items-center gap-0.5">
                    <span className="font-semibold text-[#6b5c4e]">{transcript.length}</span> turns
                  </span>
                  <span className="text-[#e8e0d5]">·</span>
                  <span title={`Round ${currentRound} — each round everyone speaks once`} className="flex items-center gap-0.5">
                    round <span className="font-semibold text-[#6b5c4e]">{currentRound}</span>
                  </span>
                  {topSpeaker && (
                    <>
                      <span className="text-[#e8e0d5]">·</span>
                      <span title={`Most vocal: ${topSpeaker.id} (${topSpeaker.speeches} turns)`} className="flex items-center gap-1 max-w-[80px] truncate">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: topSpeaker.color }} />
                        <span className="truncate font-medium text-[#6b5c4e]">{topSpeaker.id.split(" ")[0]}</span>
                      </span>
                    </>
                  )}
                </div>
              );
            })()}
            {/* Drama bar */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-[#c8b89a]">drama</span>
              <div className="w-12 h-1 bg-[#e8e0d5] rounded-full overflow-hidden">
                <div className="h-full bg-[#c07820] rounded-full transition-all duration-700" style={{ width: `${dramaScore * 100}%` }} />
              </div>
            </div>
            <button
              onClick={() => setShowGraph(v => !v)}
              title={showGraph ? "Hide visualisation" : "Show visualisation"}
              className="w-8 h-8 rounded-lg border border-[#e8e0d5] hover:border-[#c8b89a] bg-[#faf7f2] hover:bg-white flex items-center justify-center text-[#a09282] text-sm transition-colors"
            >
              {showGraph ? "⊠" : "⊞"}
            </button>
          </div>
        </div>

        {/* Avatar + speaking row */}
        <div className="px-5 pb-2.5 flex items-center gap-2 min-h-[28px]">
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

      </div>

      {/* Resizable two-panel layout */}
      <div
        ref={splitContainerRef}
        className="flex-1 flex overflow-hidden"
        style={{ cursor: isDraggingSplit ? "col-resize" : "auto", userSelect: isDraggingSplit ? "none" : "auto" }}
      >

        {/* LEFT: Transcript + chat toggle — fills all space when graph is hidden */}
        <div className="flex flex-col overflow-hidden" style={{ width: showGraph ? `${splitPct}%` : "100%" }}>

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

            {/* Emotion legend */}
            <div className="mb-3">
              <button
                onClick={() => setShowLegend(v => !v)}
                className="flex items-center gap-2 text-xs text-[#a09282] hover:text-[#6b5c4e] uppercase tracking-widest font-medium transition-colors"
              >
                <span>{showLegend ? "▾" : "▸"}</span>
                Emotion colours
              </button>
              {showLegend && (
                <div className="mt-2 bg-white border border-[#e8e0d5] rounded-xl px-4 py-3 grid grid-cols-3 gap-x-4 gap-y-1.5">
                  {Object.entries(EMOTION_STYLE)
                    .filter(([key]) => key !== "neutral")
                    .map(([key, em]) => (
                      <div key={key} className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: em.dot }} />
                        <span className="text-xs text-[#6b5c4e]">{em.label}</span>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>

            {transcript.map((entry, i) => {
              const N = Math.max(activeCharacters.length, 1);
              const entryRound = Math.floor(entry.round / N) + 1;
              const prevEntryRound = i > 0 ? Math.floor(transcript[i - 1].round / N) + 1 : null;
              const showRoundSep = entryRound !== prevEntryRound && !entry.isObserver;
              const isTwoChar = activeCharacters.length === 2;
              const charIdx = activeCharacters.indexOf(entry.character);
              const isRight = isTwoChar && charIdx === 1;

              // World observer / interrogator entries
              if (entry.isObserver) return (
                <div key={i}>
                  {entry.character === "The Interrogator" ? (
                    <div className="my-4 mx-1 rounded-xl px-4 py-3 border border-zinc-600/60" style={{ background: "linear-gradient(135deg, #18181b 0%, #1c1917 100%)" }}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs uppercase tracking-widest font-bold text-zinc-400">⚖ The Interrogator</span>
                        <span className="text-xs text-zinc-600 italic">· structural voice</span>
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
                  {showRoundSep && (
                    <div className="flex items-center gap-3 my-4 px-1">
                      <div className="flex-1 h-px bg-[#e8e0d5]" />
                      <span className="text-xs uppercase tracking-[0.2em] text-[#c8b89a] font-semibold">Round {entryRound}</span>
                      <div className="flex-1 h-px bg-[#e8e0d5]" />
                    </div>
                  )}
                  <div className={`flex gap-3 py-1.5 ${isRight ? "flex-row-reverse" : ""}`}>
                    <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white font-bold text-xs mt-0.5 shadow-sm"
                      style={{ backgroundColor: c.hex }}>
                      {initials(entry.character)}
                    </div>
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

            {streamingEnding && !alternateEnding && (
              <div className="mt-8 pt-8 border-t border-[#e8e0d5]">
                <div className="flex items-center gap-2 text-xs text-[#a09282] mb-5 uppercase tracking-widest font-medium">
                  <span className="animate-breathe text-[#c07820]">✦</span> Writing the alternate ending…
                </div>
                <div className="text-[#2d1f14] leading-[2] text-[16px]" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                  {streamingEnding}<span className="animate-pulse text-[#c07820]">▌</span>
                </div>
              </div>
            )}

            {status === "done" && alternateEnding && (
              <div className="mt-8 pt-8 border-t border-[#e8e0d5] space-y-3">
                <button
                  onClick={() => setShowConclusion(true)}
                  className="w-full py-4 rounded-2xl bg-[#1c1410] text-white font-semibold text-sm hover:bg-[#2d1f14] transition-colors flex items-center justify-center gap-2"
                >
                  <span className="text-[#f0c060]">✦</span> Read the Alternate Ending
                </button>
                <Link
                  href={`/story/${id}/debate`}
                  className="block text-center text-sm text-[#a09282] hover:text-[#6b5c4e] transition-colors py-2 font-medium"
                >
                  Start another debate →
                </Link>
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

        {/* Drag handle — always mounted, hidden via display:none when graph closed */}
        <div
          className={`w-1.5 shrink-0 transition-colors cursor-col-resize group relative ${isDraggingSplit ? "bg-[#c07820]" : "bg-[#e8e0d5] hover:bg-[#c07820]/60"}`}
          style={{ display: showGraph ? "block" : "none" }}
          onMouseDown={() => { isDraggingRef.current = true; setIsDraggingSplit(true); }}
        >
          {/* Grip dots */}
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-1 pointer-events-none">
            <div className={`w-0.5 h-0.5 rounded-full transition-colors ${isDraggingSplit ? "bg-white" : "bg-[#c8b89a] group-hover:bg-[#c07820]"}`} />
            <div className={`w-0.5 h-0.5 rounded-full transition-colors ${isDraggingSplit ? "bg-white" : "bg-[#c8b89a] group-hover:bg-[#c07820]"}`} />
            <div className={`w-0.5 h-0.5 rounded-full transition-colors ${isDraggingSplit ? "bg-white" : "bg-[#c8b89a] group-hover:bg-[#c07820]"}`} />
          </div>
        </div>

        {/* RIGHT: Visualization panel — always mounted so canvas/physics survives toggle */}
        <div className="flex flex-col overflow-hidden bg-[#f7f3ed]"
          style={{ flex: 1, display: showGraph ? "flex" : "none" }}>

          {/* Tab bar */}
          <div className="shrink-0 flex border-b border-[#e8e0d5] bg-[#f0ece5]">
            {(["graph", "heatmap", "emotions"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === tab
                    ? "text-[#3d2f20] border-[#c07820]"
                    : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
                }`}>
                {tab === "graph" ? "⬡ Graph" : tab === "heatmap" ? "▦ Heatmap" : "◉ Emotions"}
              </button>
            ))}
          </div>

          {/* Canvas layers — all always mounted so graph physics stays alive */}
          <div className="flex-1 relative min-h-0">

            {/* Graph */}
            <div style={{ position:"absolute", inset:0, opacity: activeTab==="graph" ? 1 : 0, pointerEvents: activeTab==="graph" ? "auto" : "none", transition:"opacity 0.15s" }}>
              <canvas ref={graphCanvasRef} style={{ display:"block", width:"100%", height:"100%", cursor:"grab" }} />
              {/* Edge hover tooltip */}
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
              <div className="absolute top-3 right-3 flex flex-col gap-1">
                {[
                  { label: "+", title: "Zoom in",  action: () => { zoomRef.current = Math.min(4, zoomRef.current * 1.25); } },
                  { label: "⊡", title: "Fit view",  action: () => {
                    const nodes = graphNodesRef.current;
                    const c = graphCanvasRef.current;
                    if (!nodes.length || !c) { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; return; }
                    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
                    const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40;
                    const minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + 40;
                    const scale = Math.min(c.width / (maxX - minX), c.height / (maxY - minY), 2);
                    zoomRef.current = scale;
                    panRef.current = { x: c.width/2 - (minX+maxX)/2 * scale, y: c.height/2 - (minY+maxY)/2 * scale };
                  }},
                  { label: "−", title: "Zoom out", action: () => { zoomRef.current = Math.max(0.25, zoomRef.current * 0.8); } },
                ].map(({ label, title, action }) => (
                  <button key={label} title={title} onClick={action}
                    className="w-7 h-7 rounded-lg bg-white/80 hover:bg-white border border-[#d8cfc5] text-[#6b5c4e] hover:text-[#3d2f20] text-sm flex items-center justify-center transition-colors font-mono shadow-sm">
                    {label}
                  </button>
                ))}
              </div>
              {/* Graph legend — collapsible + draggable */}
              <div
                className="absolute select-none"
                style={{
                  left: graphLegendPos.x,
                  bottom: graphLegendPos.y < 0 ? 12 : undefined,
                  top: graphLegendPos.y >= 0 ? graphLegendPos.y : undefined,
                  cursor: "grab",
                  zIndex: 10,
                }}
                onMouseDown={e => {
                  e.preventDefault();
                  const el = e.currentTarget.parentElement!;
                  const rect = el.getBoundingClientRect();
                  graphLegendDragRef.current = {
                    active: true,
                    sx: e.clientX, sy: e.clientY,
                    ox: graphLegendPos.x,
                    oy: graphLegendPos.y < 0 ? rect.height - (e.currentTarget.getBoundingClientRect().bottom - rect.top) - 12 : graphLegendPos.y,
                  };
                  const onMove = (me: MouseEvent) => {
                    if (!graphLegendDragRef.current.active) return;
                    const dx = me.clientX - graphLegendDragRef.current.sx;
                    const dy = me.clientY - graphLegendDragRef.current.sy;
                    setGraphLegendPos({
                      x: Math.max(4, graphLegendDragRef.current.ox + dx),
                      y: Math.max(4, graphLegendDragRef.current.oy + dy),
                    });
                  };
                  const onUp = () => { graphLegendDragRef.current.active = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              >
                <div className="bg-white/90 backdrop-blur-sm border border-[#d8cfc5] rounded-xl shadow-sm overflow-hidden">
                  <button
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#f7f3ed] transition-colors"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={() => setGraphLegendCollapsed(v => !v)}
                  >
                    <span className="text-[#a09282] text-xs uppercase tracking-widest font-medium">Legend</span>
                    <span className="text-[#a09282] text-xs ml-3">{graphLegendCollapsed ? "▸" : "▾"}</span>
                  </button>
                  {!graphLegendCollapsed && (
                    <div className="px-3 pb-2.5 space-y-1.5 border-t border-[#e8e0d5]">
                      <div className="flex items-center gap-2 pt-1.5"><div className="w-8 h-px bg-[#8a7260]/50" /><span className="text-[#8a7260] text-xs">Replied</span></div>
                      <div className="flex items-center gap-2"><div className="w-8 h-px bg-[#c07820]/70" /><span className="text-[#c07820]/80 text-xs">Asked question</span></div>
                      <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#8a7260]/40 border border-[#8a7260]/40" /><span className="text-[#a09282] text-xs">Node size = speeches</span></div>
                      <div className="flex items-center gap-2"><span className="text-[#c07820] text-xs">✦</span><span className="text-[#a09282] text-xs">Hidden depth turn</span></div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Heatmap */}
            <div style={{ position:"absolute", inset:0, opacity: activeTab==="heatmap" ? 1 : 0, pointerEvents: activeTab==="heatmap" ? "auto" : "none", transition:"opacity 0.15s" }}>
              <canvas ref={heatmapCanvasRef} style={{ display:"block", width:"100%", height:"100%" }} />
              {/* Heatmap legend */}
              <div className="absolute top-3 right-3">
                <div className="bg-white/90 backdrop-blur-sm border border-[#d8cfc5] rounded-xl shadow-sm overflow-hidden">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#f7f3ed] transition-colors"
                    onClick={() => setHeatmapLegendOpen(v => !v)}
                  >
                    <span className="text-[#a09282] text-xs uppercase tracking-widest font-medium">How to read</span>
                    <span className="text-[#a09282] text-xs">{heatmapLegendOpen ? "▾" : "▸"}</span>
                  </button>
                  {heatmapLegendOpen && (
                    <div className="px-3 pb-3 space-y-2 border-t border-[#e8e0d5] max-w-[220px]">
                      <p className="text-xs text-[#6b5c4e] pt-2 leading-relaxed">
                        Each cell shows how many times the <span className="font-semibold text-[#3d2f20]">row character</span> directly addressed the <span className="font-semibold text-[#3d2f20]">column character</span>.
                      </p>
                      <div className="space-y-1.5 pt-0.5">
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-sm shrink-0" style={{ background: "rgba(192,80,10,0.8)" }} />
                          <span className="text-xs text-[#6b5c4e]">Many replies (high intensity)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-sm shrink-0" style={{ background: "rgba(230,180,140,0.2)" }} />
                          <span className="text-xs text-[#6b5c4e]">Few replies (low intensity)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-sm shrink-0 border border-[#c8b89a]/40" style={{ background: "rgba(200,184,154,0.15)" }} />
                          <span className="text-xs text-[#6b5c4e]">Diagonal — same character</span>
                        </div>
                      </div>
                      <p className="text-xs text-[#a09282] border-t border-[#e8e0d5] pt-2">The number inside = exact reply count.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Emotions arc */}
            <div style={{ position:"absolute", inset:0, opacity: activeTab==="emotions" ? 1 : 0, pointerEvents: activeTab==="emotions" ? "auto" : "none", transition:"opacity 0.15s" }}>
              <canvas ref={emotionsCanvasRef} style={{ display:"block", width:"100%", height:"100%" }} />
              {/* Emotion legend */}
              <div className="absolute top-3 right-3">
                <div className="bg-white/90 backdrop-blur-sm border border-[#d8cfc5] rounded-xl shadow-sm overflow-hidden">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#f7f3ed] transition-colors"
                    onClick={() => setEmotionLegendOpen(v => !v)}
                  >
                    <span className="text-[#a09282] text-xs uppercase tracking-widest font-medium">Emotions</span>
                    <span className="text-[#a09282] text-xs">{emotionLegendOpen ? "▾" : "▸"}</span>
                  </button>
                  {emotionLegendOpen && (
                    <div className="px-3 pb-3 border-t border-[#e8e0d5] max-w-[200px]">
                      <p className="text-xs text-[#6b5c4e] pt-2 pb-2 leading-relaxed">Each dot = one speech. Colour = detected emotion at that moment.</p>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                        {Object.entries(EMOTION_STYLE).filter(([k]) => k !== "neutral").map(([, em]) => (
                          <div key={em.label} className="flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: em.dot }} />
                            <span className="text-xs text-[#6b5c4e]">{em.label}</span>
                          </div>
                        ))}
                        <div className="flex items-center gap-1.5 col-span-2 pt-1 border-t border-[#e8e0d5]">
                          <span className="text-[#c07820] text-xs">✦</span>
                          <span className="text-xs text-[#6b5c4e]">hidden depth turn</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Stats bar (graph tab only) */}
          {graphStats.length > 0 && activeTab === "graph" && (() => {
            const sorted = [...graphStats].sort((a, b) => b.speeches - a.speeches);
            const maxSpeeches = sorted[0]?.speeches || 1;
            const total = sorted.reduce((s, n) => s + n.speeches, 0) || 1;
            return (
              <div className="shrink-0 border-t border-[#e8e0d5] bg-[#f0ece5]">
                {/* Collapsible header */}
                <button
                  onClick={() => setShowStats(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[#e8e0d5]/60 transition-colors"
                >
                  <span className="text-xs uppercase tracking-widest text-[#a09282] font-medium">Voice share</span>
                  <span className="text-[#a09282] text-xs">{showStats ? "▾" : "▸"}</span>
                </button>
                {showStats && <div className="px-3 pb-2.5 space-y-1.5">
                {sorted.map(n => (
                  <div key={n.id} className="flex items-center gap-2">
                    <span className="text-xs text-[#8a7260] w-16 shrink-0 truncate">{n.id.split(" ")[0]}</span>
                    <div className="flex-1 h-1.5 bg-[#d8cfc5] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(n.speeches / maxSpeeches) * 100}%`, backgroundColor: n.color }} />
                    </div>
                    <span className="text-xs font-bold w-10 text-right shrink-0" style={{ color: n.color }}>{Math.round((n.speeches / total) * 100)}%</span>
                  </div>
                ))}
                </div>}
              </div>
            );
          })()}
        </div>

      </div>

      {/* ── Full-screen Book Conclusion — two-column layout ── */}
      {showConclusion && alternateEnding && (
        <div className="absolute inset-0 z-50 flex flex-col" style={{ background: "#f7f3ed" }}>

          {/* Sticky nav */}
          <div className="shrink-0 border-b border-[#e8e0d5] flex items-center justify-between px-8 py-3" style={{ background: "rgba(247,243,237,0.97)", backdropFilter: "blur(12px)" }}>
            <span className="text-[#c07820] font-bold text-sm tracking-wider">✦ WhatIfSabha</span>
            <div className="flex items-center gap-2">
              <Link href={`/story/${id}/debate`} className="text-sm text-[#6b5c4e] hover:text-[#1c1410] border border-[#e8e0d5] hover:border-[#c8b89a] px-4 py-2 rounded-lg transition-colors font-medium">New debate →</Link>
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
              <div className="text-[#c07820] text-xs uppercase tracking-[0.45em] font-semibold">Alternate History</div>
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
                                  {(ev.characters as string[]).map((c: string) => {
                                    const ci = activeCharacters.indexOf(c);
                                    const ccol = CHAR_COLORS[ci >= 0 ? ci % CHAR_COLORS.length : 0].hex;
                                    return <span key={c} className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: ccol + "18", color: ccol }}>{c}</span>;
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

          {/* THE ALTERNATE ENDING */}
          <div style={{ background: "#fefcf8" }} className="py-24">
            <div className="max-w-[780px] mx-auto px-8 lg:px-12">
              <div className="text-center mb-16">
                <div className="flex items-center justify-center gap-5 mb-8">
                  <div className="flex-1 h-px bg-[#e8e0d5]" />
                  <span className="text-[#c07820] text-xl">✦</span>
                  <div className="flex-1 h-px bg-[#e8e0d5]" />
                </div>
                <div className="text-xs uppercase tracking-[0.4em] text-[#a09282] font-semibold">The Alternate Ending</div>
              </div>
              <div className="text-[#2d1f14] leading-[2.2] text-[20px]" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                <ReactMarkdown
                  components={{
                    p: ({ children, ...props }) => {
                      const node = props.node as any;
                      const isFirst = node?.position?.start?.line === 1;
                      return isFirst
                        ? <p className="mb-8 first-letter:text-6xl first-letter:font-bold first-letter:float-left first-letter:mr-3 first-letter:leading-none first-letter:text-[#c07820]">{children}</p>
                        : <p className="mb-6 indent-8">{children}</p>;
                    },
                    em: ({ children }) => <em style={{ color: "#6b5c4e" }}>{children}</em>,
                    strong: ({ children }) => <strong style={{ color: "#1c1410", fontWeight: 600 }}>{children}</strong>,
                  }}
                >{alternateEnding}</ReactMarkdown>
              </div>
              <div className="mt-20 text-center space-y-2">
                <div className="text-[#c07820] text-lg tracking-[0.5em]">✦ ✦ ✦</div>
                <p className="text-xs text-[#a09282] mt-3">Shaped by {activeCharacters.join(", ")} · {transcript.length} exchanges</p>
              </div>
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
                        if (conclusionTab === "oracle") { setOracleHistory([]); setShowOracle(true); }
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
