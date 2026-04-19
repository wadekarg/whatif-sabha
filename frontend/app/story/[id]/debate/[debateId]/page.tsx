"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { API } from "../../../../config";
import { exportDebateToPdf } from "../../../../lib/exportDebate";

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

type DebateEntry = { character: string; message: string; round: number; target?: string; target_character?: string; target_characters?: string[]; emotion?: string; isObserver?: boolean; observerEra?: string; };
type GraphNode   = { id: string; x: number; y: number; vx: number; vy: number; r: number; color: string; speeches: number; };
type SpeechAct   = "question" | "response" | "statement";
type GraphEdge   = { source: string; target: string; count: number; questions: number; speech_act?: SpeechAct; };

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

export default function DebateViewPage() {
  const { id, debateId } = useParams<{ id: string; debateId: string }>();

  const [debate, setDebate]     = useState<any>(null);
  const [loading, setLoading]   = useState(true);
  const [showLegend, setShowLegend] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showConclusion, setShowConclusion] = useState(false);
  const [showOracle, setShowOracle] = useState(false);
  const [oracleCharacter, setOracleCharacter] = useState("");
  const [oracleInput, setOracleInput] = useState("");
  const [oracleHistory, setOracleHistory] = useState<{role:string;content:string;character?:string}[]>([]);
  const [oracleStreaming, setOracleStreaming] = useState("");
  const [oracleLoading, setOracleLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"graph"|"heatmap"|"emotions">("graph");
  const [splitPct, setSplitPct] = useState(42);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef     = useRef(false);
  const bottomRef         = useRef<HTMLDivElement>(null);

  const [chatMessages, setChatMessages] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [chatLoading, setChatLoading]   = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Graph
  const graphCanvasRef = useRef<HTMLCanvasElement>(null);
  const graphNodesRef  = useRef<GraphNode[]>([]);
  const graphEdgesRef  = useRef<GraphEdge[]>([]);
  const graphAnimRef   = useRef<number>(0);
  const zoomRef        = useRef(1);
  const panRef         = useRef({ x: 0, y: 0 });
  const graphDragRef   = useRef({ active: false, sx: 0, sy: 0, px: 0, py: 0 });
  const heatmapCanvasRef  = useRef<HTMLCanvasElement>(null);
  const emotionsCanvasRef = useRef<HTMLCanvasElement>(null);
  const [graphStats, setGraphStats] = useState<{id: string; color: string; speeches: number}[]>([]);
  const graphReady     = useRef(false); // prevent re-building graph on re-renders

  const colorOf = (name: string, chars: string[]) =>
    CHAR_COLORS[chars.indexOf(name) % CHAR_COLORS.length] || CHAR_COLORS[0];
  const initials = (name: string) =>
    name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

  // Resizable split drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(20, Math.min(75, pct)));
    };
    const onUp = () => { isDraggingRef.current = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  // Build graph from full transcript
  const buildGraph = (transcript: DebateEntry[], chars: string[]) => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const W = canvas.offsetWidth || 500, H = canvas.offsetHeight || 500;
    canvas.width = W; canvas.height = H;
    graphNodesRef.current = [];
    graphEdgesRef.current = [];

    const ensureNode = (name: string): GraphNode => {
      let node = graphNodesRef.current.find(n => n.id === name);
      if (!node) {
        const idx = chars.indexOf(name);
        const hex = name === "Boru" ? "#c07820" : (CHAR_COLORS[Math.max(0, idx) % CHAR_COLORS.length]).hex;
        const total = chars.length || 1;
        const angle = (Math.max(0, idx) / total) * 2 * Math.PI;
        const dist = Math.min(W, H) * 0.3;
        node = name === "Boru"
          ? {
              id: name,
              x: W / 2, y: H / 2,
              vx: 0, vy: 0, r: 20, color: hex, speeches: 0,
            }
          : {
              id: name,
              x: W / 2 + Math.cos(angle) * dist + (Math.random() - 0.5) * 30,
              y: H / 2 + Math.sin(angle) * dist + (Math.random() - 0.5) * 30,
              vx: 0, vy: 0, r: 18, color: hex, speeches: 0,
            };
        graphNodesRef.current.push(node);
      }
      return node;
    };

    // Ensure Boru node exists (he may not appear as a speaker if no character addressed him before)
    ensureNode("Boru");

    for (const entry of transcript) {
      // Skip non-dialogue entries (orchestrator, reactions, stage directions)
      if ((entry as any).isOrchestrator || (entry as any).isReaction || (entry as any).isStageDirection || (entry as any).isAudience) continue;
      const node = ensureNode(entry.character);
      node.speeches++;
      node.r = Math.min(18 + node.speeches * 1.5, 34);
      // Backend stores as target_characters (array); frontend SSE stored as targets (array) or target_character (string for backward compat)
      const targetNames = (entry as any).target_characters || (entry as any).targets ||
                          ((entry as any).target_character ? [(entry as any).target_character] : []) ||
                          (entry.target ? [entry.target] : []);

      // Create an edge for each target
      const act = classifySpeechAct(
        entry.message,
        (entry.target_characters as string[] | undefined) ?? (entry.target_character ? [entry.target_character] : []),
      );
      const isQ = act === "question";
      for (const targetName of targetNames) {
        if (targetName && targetName !== entry.character && targetName !== "all") {
          ensureNode(targetName);
          const existing = graphEdgesRef.current.find(e => e.source === entry.character && e.target === targetName);
          if (existing) { existing.count++; if (isQ) existing.questions++; }
          else graphEdgesRef.current.push({
            source: entry.character, target: targetName,
            count: 1, questions: isQ ? 1 : 0,
            speech_act: act,
          });
        }
      }
    }
    setGraphStats(graphNodesRef.current.map(n => ({ id: n.id, color: n.color, speeches: n.speeches })));
  };

  // Load debate
  useEffect(() => {
    fetch(`${API}/debates/${debateId}`)
      .then(r => r.json())
      .then(d => { setDebate(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [debateId]);

  // Build graph once canvas is ready + debate loaded
  useEffect(() => {
    if (!debate || graphReady.current) return;
    // Wait a tick for the canvas to be in the DOM
    const timer = setTimeout(() => {
      buildGraph(debate.transcript || [], debate.participating_characters || []);
      graphReady.current = true;
    }, 50);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debate]);

  // Graph physics + render loop
  useEffect(() => {
    if (!debate) return;
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;

    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener("resize", resize);

    // Wheel zoom
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

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onCanvasDown);
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragUp);

    const drawArrow = (ctx: CanvasRenderingContext2D, tx: number, ty: number, ux: number, uy: number, size: number) => {
      const ax = tx - ux*size - uy*(size*0.6), ay = ty - uy*size + ux*(size*0.6);
      const bx = tx - ux*size + uy*(size*0.6), by = ty - uy*size - ux*(size*0.6);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ax, ay); ctx.lineTo(bx, by); ctx.closePath(); ctx.fill();
    };

    const tick = () => {
      frame++;
      const nodes = graphNodesRef.current;
      const edges = graphEdgesRef.current;
      const W = canvas.width, H = canvas.height;
      const cx = W / 2, cy = H / 2;

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
        const src = nodes.find(n => n.id === e.source), tgt = nodes.find(n => n.id === e.target);
        if (!src || !tgt) continue;
        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const ideal = 110 + src.r + tgt.r;
        const f = (d - ideal) * 0.025;
        src.vx += (dx/d)*f; src.vy += (dy/d)*f;
        tgt.vx -= (dx/d)*f; tgt.vy -= (dy/d)*f;
      }
      // Gravity + damping + bounds
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.008; n.vy += (cy - n.y) * 0.008;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(n.r + 12, Math.min(W - n.r - 12, n.x));
        n.y = Math.max(n.r + 12, Math.min(H - n.r - 12, n.y));
      }

      // Draw
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#09090b"; ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(panRef.current.x, panRef.current.y);
      ctx.scale(zoomRef.current, zoomRef.current);

      // Edges — parallel strand bundle (one strand per interaction)
      for (const e of edges) {
        const src = nodes.find(n => n.id === e.source), tgt = nodes.find(n => n.id === e.target);
        if (!src || !tgt) continue;
        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const ux = dx/d, uy = dy/d;
        const px = -uy, py = ux;
        const isQ = e.questions > 0;
        const isBoruEdge = e.target === "Boru" || e.source === "Boru";
        const col = isBoruEdge ? "#c07820" : (isQ ? "#f0c060" : src.color);
        const strandCount = e.count;
        const spacing = strandCount > 1 ? Math.min(3.2, 32 / (strandCount - 1)) : 0;
        const hasMirror = edges.some(e2 => e2.source === e.target && e2.target === e.source);
        const baseCurve = hasMirror ? 28 : 0;

        for (let si = 0; si < strandCount; si++) {
          const strandOff = (si - (strandCount - 1) / 2) * spacing;
          const curveOff = baseCurve + strandOff * 0.6;
          const cpX = (src.x + tgt.x) / 2 + px * (strandOff + curveOff);
          const cpY = (src.y + tgt.y) / 2 + py * (strandOff + curveOff);
          const sxe = src.x + ux * src.r + px * strandOff * 0.4;
          const sye = src.y + uy * src.r + py * strandOff * 0.4;
          const txe = tgt.x - ux * tgt.r + px * strandOff * 0.4;
          const tye = tgt.y - uy * tgt.r + py * strandOff * 0.4;
          const edgeFade = 1 - Math.abs(si - (strandCount - 1) / 2) / (strandCount * 0.8);
          const alpha = Math.min(0.55 + edgeFade * 0.35, 0.9);
          ctx.save();
          ctx.beginPath(); ctx.moveTo(sxe, sye); ctx.quadraticCurveTo(cpX, cpY, txe, tye);
          ctx.strokeStyle = col + Math.round(alpha * 255).toString(16).padStart(2, "0");
          ctx.lineWidth = isBoruEdge ? 2.2 : 1.2;
          if (isBoruEdge) ctx.setLineDash([]);
          ctx.stroke();
          ctx.restore();
        }

        // Arrowhead on central strand
        const cpX0 = (src.x + tgt.x) / 2 + px * baseCurve;
        const cpY0 = (src.y + tgt.y) / 2 + py * baseCurve;
        const txe0 = tgt.x - ux * tgt.r, tye0 = tgt.y - uy * tgt.r;
        const arrowDx = txe0 - cpX0, arrowDy = tye0 - cpY0;
        const arrowD = Math.sqrt(arrowDx*arrowDx + arrowDy*arrowDy) || 1;
        ctx.fillStyle = col + "cc";
        drawArrow(ctx, txe0, tye0, arrowDx/arrowD, arrowDy/arrowD, isBoruEdge ? 9 : 7);
      }

      // Nodes
      const pulse = Math.sin(frame * 0.05) * 0.3 + 0.7;
      for (const n of nodes) {
        const glowR = n.r * 2;
        const grd = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, glowR);
        grd.addColorStop(0, n.color + "33"); grd.addColorStop(1, "transparent");
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, 2*Math.PI);
        ctx.fillStyle = grd; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x + 2, n.y + 3, n.r, 0, 2*Math.PI);
        ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 2*Math.PI);
        ctx.fillStyle = n.color; ctx.fill();
        const fontSize = Math.max(10, Math.min(13, n.r * 0.65));
        ctx.font = `bold ${fontSize}px Inter, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillText(n.id.split(" ").map((w:string) => w[0]).join("").slice(0,2).toUpperCase(), n.x, n.y);
        const name = n.id.split(" ").slice(0, 2).join(" ");
        ctx.font = `600 ${Math.max(9, Math.min(11, n.r * 0.5))}px Inter, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillStyle = `rgba(255,255,255,${0.55 + pulse * 0.1})`;
        ctx.fillText(name, n.x, n.y + n.r + 4);
        if (n.speeches > 0) {
          const bx = n.x + n.r * 0.7, by = n.y - n.r * 0.7;
          ctx.beginPath(); ctx.arc(bx, by, 7, 0, 2*Math.PI);
          ctx.fillStyle = "#1a1a2e"; ctx.fill();
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
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.fillText("Building graph…", W/2, H/2);
      }

      graphAnimRef.current = requestAnimationFrame(tick);
    };

    graphAnimRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(graphAnimRef.current);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onCanvasDown);
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debate]);

  // Heatmap
  useEffect(() => {
    if (!debate) return;
    const canvas = heatmapCanvasRef.current;
    const transcript: any[] = debate.transcript || [];
    const chars: string[] = debate.participating_characters || [];
    if (!canvas || chars.length === 0) return;
    canvas.width = canvas.offsetWidth || 400; canvas.height = canvas.offsetHeight || 400;
    const ctx = canvas.getContext("2d")!;
    const N = chars.length, W = canvas.width, H = canvas.height;
    ctx.fillStyle = "#09090b"; ctx.fillRect(0, 0, W, H);
    if (transcript.length === 0) { ctx.font="13px Inter,sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillStyle="rgba(255,255,255,0.18)"; ctx.fillText("No transcript",W/2,H/2); return; }
    const counts: number[][] = Array.from({length:N},()=>Array(N).fill(0));
    let maxCount = 0;
    for (const e of transcript) { const i=chars.indexOf(e.character),j=e.target_character?chars.indexOf(e.target_character):-1; if(i>=0&&j>=0&&i!==j){counts[i][j]++;maxCount=Math.max(maxCount,counts[i][j]);} }
    const pad=Math.min(W,H)*0.18, cellSize=Math.min((W-pad)/N,(H-pad)/N,64), gridLeft=pad, gridTop=pad;
    for (let i=0;i<N;i++) for (let j=0;j<N;j++) {
      const x=gridLeft+j*cellSize,y=gridTop+i*cellSize,intensity=maxCount>0?counts[i][j]/maxCount:0;
      ctx.fillStyle=i===j?"rgba(255,255,255,0.04)":`rgba(${Math.round(192*intensity+20*(1-intensity))},${Math.round(100*intensity+20*(1-intensity))},${Math.round(20*intensity)},${0.15+intensity*0.8})`;
      ctx.fillRect(x,y,cellSize-2,cellSize-2);
      if(counts[i][j]>0){ctx.font=`bold ${Math.max(9,cellSize*0.32)}px Inter,sans-serif`;ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle=`rgba(255,255,255,${0.45+intensity*0.55})`;ctx.fillText(String(counts[i][j]),x+cellSize/2,y+cellSize/2);}
    }
    for(let i=0;i<N;i++){ctx.font=`600 ${Math.min(11,cellSize*0.38)}px Inter,sans-serif`;ctx.textAlign="right";ctx.textBaseline="middle";ctx.fillStyle=(CHAR_COLORS[i%CHAR_COLORS.length]).hex;ctx.fillText(chars[i].split(" ")[0],gridLeft-6,gridTop+i*cellSize+cellSize/2);}
    for(let j=0;j<N;j++){ctx.save();ctx.translate(gridLeft+j*cellSize+cellSize/2,gridTop-6);ctx.rotate(-Math.PI/4);ctx.font=`600 ${Math.min(11,cellSize*0.38)}px Inter,sans-serif`;ctx.textAlign="right";ctx.textBaseline="middle";ctx.fillStyle=(CHAR_COLORS[j%CHAR_COLORS.length]).hex;ctx.fillText(chars[j].split(" ")[0],0,0);ctx.restore();}
    ctx.font="9px Inter,sans-serif";ctx.textAlign="left";ctx.textBaseline="bottom";ctx.fillStyle="rgba(255,255,255,0.2)";ctx.fillText("row = speaker   col = spoken to",4,H-4);
  }, [debate, activeTab]);

  // Emotions arc
  useEffect(() => {
    if (!debate) return;
    const canvas = emotionsCanvasRef.current;
    const transcript: any[] = debate.transcript || [];
    const chars: string[] = debate.participating_characters || [];
    if (!canvas || chars.length === 0 || transcript.length === 0) return;
    canvas.width = canvas.offsetWidth || 400; canvas.height = canvas.offsetHeight || 400;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = "#09090b"; ctx.fillRect(0, 0, W, H);
    const padL=72,padR=16,padT=16,padB=24, rowH=(H-padT-padB)/chars.length, totalTurns=transcript.length;
    const xOf=(idx:number)=>padL+(totalTurns<=1?0.5:idx/(totalTurns-1))*(W-padL-padR);
    for (let ci=0;ci<chars.length;ci++) {
      const charName=chars[ci], color=CHAR_COLORS[ci%CHAR_COLORS.length].hex, y=padT+ci*rowH+rowH/2;
      ctx.strokeStyle="rgba(255,255,255,0.05)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,padT+ci*rowH);ctx.lineTo(W-padR,padT+ci*rowH);ctx.stroke();
      ctx.font="600 10px Inter,sans-serif";ctx.textAlign="right";ctx.textBaseline="middle";ctx.fillStyle=color;ctx.fillText(charName.split(" ")[0],padL-6,y);
      const turns=transcript.map((e:any,idx:number)=>({...e,idx})).filter((e:any)=>e.character===charName);
      if(!turns.length)continue;
      ctx.strokeStyle=color+"25";ctx.lineWidth=1.2;ctx.setLineDash([]);ctx.beginPath();
      turns.forEach((t:any,ti:number)=>{const x=xOf(t.idx);ti===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
      ctx.stroke();
      for(const turn of turns){
        const x=xOf(turn.idx),em=EMOTION_STYLE[turn.emotion||"neutral"]||EMOTION_STYLE.neutral;
        const grd=ctx.createRadialGradient(x,y,2,x,y,11);grd.addColorStop(0,em.dot+"70");grd.addColorStop(1,"transparent");
        ctx.beginPath();ctx.arc(x,y,11,0,2*Math.PI);ctx.fillStyle=grd;ctx.fill();
        ctx.beginPath();ctx.arc(x,y,5,0,2*Math.PI);ctx.fillStyle=em.dot;ctx.fill();
        if(em.label&&W/Math.max(totalTurns,1)>36){ctx.font="8px Inter,sans-serif";ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle=em.dot+"aa";ctx.fillText(em.label,x,y+8);}
      }
    }
    ctx.font="9px Inter,sans-serif";ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle="rgba(255,255,255,0.18)";
    const step=Math.max(1,Math.floor(totalTurns/8));
    for(let i=0;i<totalTurns;i+=step)ctx.fillText(String(i+1),xOf(i),H-padB+4);
  }, [debate, activeTab]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatLoading]);

  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q || chatLoading) return;
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

  const sendOracleQuestion = async () => {
    const q = oracleInput.trim();
    if (!q || oracleLoading || !oracleCharacter) return;
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
            if (ev.type === "error") { full = ev.message || "The oracle could not reach this character."; }
            if (ev.type === "done") {
              setOracleHistory(prev => [...prev, { role: "assistant", content: full || "…", character: oracleCharacter }]);
              setOracleStreaming("");
              gotDone = true;
            }
          } catch (e) { console.error("Failed to parse oracle SSE:", e); }
        }
      }
      if (!gotDone) {
        setOracleHistory(prev => [...prev, { role: "assistant", content: full || "The oracle could not reach this character.", character: oracleCharacter }]);
        setOracleStreaming("");
      }
    } catch {
      setOracleHistory(prev => [...prev, { role: "assistant", content: "The oracle could not reach this character.", character: oracleCharacter }]);
      setOracleStreaming("");
    } finally {
      setOracleLoading(false);
    }
  };

  if (loading) return (
    <main className="flex-1 flex items-center justify-center bg-[#f7f3ed]">
      <div className="text-[#a09282] animate-breathe">Loading debate…</div>
    </main>
  );
  if (!debate) return (
    <main className="flex-1 flex items-center justify-center bg-[#f7f3ed]">
      <div className="text-red-500">Debate not found.</div>
    </main>
  );

  const chars: string[] = debate.participating_characters || [];
  const transcript: DebateEntry[] = debate.transcript || [];

  const handleExport = async () => {
    try {
      await exportDebateToPdf({
        graphElement: graphCanvasRef.current,
        turns: transcript as any,
        meta: {
          storyTitle: debate.story_title || debate.divergence_description || "Debate",
          storyAuthor: debate.story_author,
          divergence: debate.divergence_description || "",
          exportedAt: new Date(),
          cast: chars.map((name, i) => ({
            name,
            color: CHAR_COLORS[i % CHAR_COLORS.length]?.hex,
          })),
          alternateEnding: debate.alternate_ending || undefined,
        },
      });
    } catch (e) {
      console.error("Export failed:", e);
      alert("Export failed — see console for details.");
    }
  };

  return (
    <main className="relative flex flex-col bg-[#f7f3ed] overflow-hidden" style={{ height: "calc(100vh - 56px)" }}>
      {/* Sub-header */}
      <div className="sticky top-14 z-40 border-b border-[#e8e0d5] bg-white/95 backdrop-blur-sm shrink-0">
        <div className="px-6 py-2.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-xs transition-colors shrink-0">← Back</Link>
            <span className="text-[#c8b89a]">·</span>
            <p className="text-[#6b5c4e] text-xs truncate italic">"{debate.divergence_description}"</p>
          </div>
          {/* Character avatar strip */}
          {chars.length > 0 && (
            <div className="flex items-center shrink-0">
              {chars.map((name, i) => {
                const col = CHAR_COLORS[i % CHAR_COLORS.length].hex;
                return (
                  <div key={name} title={name}
                    className="-ml-1 w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-white font-bold text-xs"
                    style={{ backgroundColor: col, zIndex: chars.length - i }}>
                    {initials(name)}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#fef3e2] text-[#1c1410] text-xs font-medium border border-[#f0c060]/60 hover:bg-[#fde9c9] transition-colors print:hidden"
              aria-label="Export debate as PDF"
              title="Export debate as PDF — includes title, graph, and full transcript"
            >
              📥 Export PDF
            </button>
            <span className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${
              debate.status === "completed"
                ? "border-emerald-200 text-emerald-700 bg-emerald-50"
                : "border-[#e8e0d5] text-[#a09282] bg-[#f7f3ed]"
            }`}>
              {debate.status === "completed" ? "✓ completed" : debate.status}
            </span>
          </div>
        </div>
      </div>

      {/* Resizable two-panel layout */}
      <div
        ref={splitContainerRef}
        className="flex-1 flex overflow-hidden"
        style={{ userSelect: isDraggingRef.current ? "none" : "auto" }}
      >
        {/* LEFT: Transcript + chat */}
        <div className="flex flex-col overflow-hidden" style={{ width: `${splitPct}%` }}>
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-1 min-h-0">

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
                    ))}
                </div>
              )}
            </div>

            {transcript.map((entry, i) => {
              // Skip reactions (no longer generated, but old transcripts may have them)
              if ((entry as any).isReaction) return null;
              if ((entry as any).isStageDirection) return null;

              const isTwoChar = chars.length === 2;
              const charIdx = chars.indexOf(entry.character);
              const isRight = isTwoChar && charIdx === 1;

              // World observer entry
              if (entry.isObserver && entry.character === "The Interrogator") {
                return (
                  <div key={i}>
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
                  </div>
                );
              }

              if (entry.isObserver) {
                return (
                  <div key={i}>
                    <div className="my-3 mx-1 bg-slate-900 rounded-xl px-4 py-3 border border-slate-700/60">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs uppercase tracking-widest font-bold text-slate-400">🌍 World Observer</span>
                        {entry.observerEra && <span className="text-xs text-slate-500 italic">· {entry.observerEra}</span>}
                        <span className="text-xs text-slate-500 font-medium ml-1">{entry.character}</span>
                      </div>
                      <div className="text-sm leading-relaxed text-slate-200">
                        <ReactMarkdown components={{
                          p: ({children}) => <p style={{marginBottom:"0.25rem"}}>{children}</p>,
                          strong: ({children}) => <strong style={{fontWeight:600,color:"#e2e8f0"}}>{children}</strong>,
                          em: ({children}) => <em style={{fontStyle:"italic",color:"#94a3b8"}}>{children}</em>,
                        }}>{entry.message}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                );
              }

              const c = colorOf(entry.character, chars);
              const em = EMOTION_STYLE[entry.emotion || "neutral"] || EMOTION_STYLE.neutral;
              const rawTarget = entry.target || entry.target_character || null;
              const targetChar = rawTarget && rawTarget !== entry.character ? rawTarget : null;
              const targetColor = targetChar ? colorOf(targetChar, chars) : null;
              const quotedMsg = targetChar
                ? [...transcript.slice(0, i)].reverse().find(e => e.character === targetChar)
                : null;
              const quoteSnippet = quotedMsg
                ? quotedMsg.message.replace(/[*_#]/g, "").slice(0, 80) + (quotedMsg.message.length > 80 ? "…" : "")
                : null;

              return (
                <div key={i}>
                  <div className={`flex gap-3 py-1.5 ${isRight ? "flex-row-reverse" : ""}`}>
                    <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white font-bold text-xs mt-0.5 shadow-sm"
                      style={{ backgroundColor: c.hex }}>
                      {initials(entry.character)}
                    </div>
                    <div className={`flex-1 min-w-0 flex flex-col ${isRight ? "items-end" : ""}`}>
                      <div className={`flex items-center gap-2 mb-1 flex-wrap ${isRight ? "flex-row-reverse" : ""}`}>
                        <span className="text-xs font-semibold" style={{ color: c.hex }}>{entry.character}</span>
                        {em.label && (
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: em.dot }} />
                            <span className="text-xs text-[#a09282]">{em.label}</span>
                          </span>
                        )}
                      </div>
                      {/* Reply quote preview */}
                      {quoteSnippet && (
                        <div className={`mb-1 px-3 py-1.5 rounded-lg text-xs text-[#6b5c4e] italic max-w-[90%] ${isRight ? "self-end" : "self-start"}`}
                          style={{ borderLeft: isRight ? undefined : `2px solid ${targetColor?.hex}`, borderRight: isRight ? `2px solid ${targetColor?.hex}` : undefined, backgroundColor: targetColor?.hex + "12" }}>
                          <span className="font-semibold not-italic text-xs" style={{ color: targetColor?.hex }}>{targetChar}</span>
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

            {debate.alternate_ending && (
              <div className="mt-8 pt-8 border-t border-[#e8e0d5] space-y-3">
                <button
                  onClick={() => setShowConclusion(true)}
                  className="w-full py-4 rounded-2xl bg-[#1c1410] text-white font-semibold text-sm hover:bg-[#2d1f14] transition-colors flex items-center justify-center gap-2"
                >
                  <span className="text-[#f0c060]">✦</span> Read the Alternate Ending
                </button>
                <Link
                  href={`/story/${id}/debate`}
                  className="block text-center text-xs text-[#a09282] hover:text-[#6b5c4e] transition-colors py-1"
                >
                  Start another debate →
                </Link>
              </div>
            )}

            <div ref={bottomRef} className="h-8" />
          </div>

          {/* Chat toggle */}
          <div data-print-hide="true" className="shrink-0 border-t border-[#e8e0d5] bg-white">
            <button
              onClick={() => setShowChat(v => !v)}
              className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-[#faf7f2] transition-colors text-left"
            >
              <div className="w-5 h-5 rounded-md bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820] shrink-0">✦</div>
              <span className="text-xs font-semibold text-[#1c1410]">Ask the Orchestrator</span>
              <span className="text-xs text-[#a09282]">about this debate</span>
              <span className="ml-auto text-[#c8b89a] text-xs">{showChat ? "▾" : "▸"}</span>
            </button>
          </div>

          {/* Chat panel */}
          {showChat && (
            <div data-print-hide="true" className="shrink-0 flex flex-col bg-white border-t border-[#e8e0d5]" style={{ height: "280px" }}>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
                {chatMessages.length === 0 && (
                  <div className="space-y-1.5 pt-1">
                    {["Who had the most impact?", "Why did they take those positions?", "What does this ending mean?"].map(q => (
                      <button key={q} onClick={() => setChatInput(q)}
                        className="w-full text-left text-xs text-[#6b5c4e] bg-[#f7f3ed] hover:bg-[#fef3e2] border border-[#e8e0d5] hover:border-[#f0c060]/50 px-3 py-2 rounded-lg transition-colors">
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
                      ) : (typeof m.content === "string" ? m.content : String(m.content))}
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
                  onKeyDown={e => { if (e.key === "Enter") sendChat(); }}
                  placeholder="Ask about the debate…"
                  className="flex-1 bg-[#f7f3ed] border border-[#e8e0d5] focus:border-[#c07820] rounded-lg px-3 py-2 text-xs text-[#1c1410] placeholder-[#c8b89a] focus:outline-none transition-colors"
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim() || chatLoading}
                  className="w-8 h-8 rounded-lg bg-[#c07820] hover:bg-[#a86a18] disabled:bg-[#e8e0d5] disabled:text-[#c8b89a] text-white flex items-center justify-center text-sm transition-colors shrink-0"
                >↑</button>
              </div>
            </div>
          )}
        </div>

        {/* Drag handle */}
        <div
          data-print-hide="true"
          className="w-1 shrink-0 bg-[#e8e0d5] hover:bg-[#c07820] transition-colors cursor-col-resize"
          onMouseDown={() => { isDraggingRef.current = true; }}
        />

        {/* RIGHT: Visualization panel */}
        <div data-print-hide="true" className="flex flex-col overflow-hidden bg-[#09090b]" style={{ flex: 1 }}>

          {/* Tab bar */}
          <div className="shrink-0 flex border-b border-white/10 bg-black/30">
            {(["graph", "heatmap", "emotions"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === tab ? "text-white border-[#c07820]" : "text-white/35 border-transparent hover:text-white/60"
                }`}>
                {tab === "graph" ? "⬡ Graph" : tab === "heatmap" ? "▦ Heatmap" : "◉ Emotions"}
              </button>
            ))}
          </div>

          {/* Canvas layers */}
          <div className="flex-1 relative min-h-0">
            {/* Graph */}
            <div style={{ position:"absolute", inset:0, opacity: activeTab==="graph"?1:0, pointerEvents: activeTab==="graph"?"auto":"none", transition:"opacity 0.15s" }}>
              <canvas ref={graphCanvasRef} style={{ display:"block", width:"100%", height:"100%", cursor:"grab" }} />
              <div className="absolute top-3 right-3 flex flex-col gap-1">
                {[
                  { label: "+", title: "Zoom in",  action: () => { zoomRef.current = Math.min(4, zoomRef.current * 1.25); } },
                  { label: "⊡", title: "Fit view",  action: () => {
                    const nodes = graphNodesRef.current; const c = graphCanvasRef.current;
                    if (!nodes.length || !c) { zoomRef.current=1; panRef.current={x:0,y:0}; return; }
                    const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y);
                    const minX=Math.min(...xs)-40,maxX=Math.max(...xs)+40,minY=Math.min(...ys)-40,maxY=Math.max(...ys)+40;
                    const scale=Math.min(c.width/(maxX-minX),c.height/(maxY-minY),2);
                    zoomRef.current=scale; panRef.current={x:c.width/2-(minX+maxX)/2*scale,y:c.height/2-(minY+maxY)/2*scale};
                  }},
                  { label: "−", title: "Zoom out", action: () => { zoomRef.current = Math.max(0.25, zoomRef.current * 0.8); } },
                ].map(({ label, title, action }) => (
                  <button key={label} title={title} onClick={action}
                    className="w-7 h-7 rounded-lg bg-black/60 hover:bg-white/10 border border-white/10 text-white/60 hover:text-white text-sm flex items-center justify-center transition-colors font-mono">
                    {label}
                  </button>
                ))}
              </div>
              <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm border border-white/10 rounded-xl px-3 py-2.5 space-y-1.5">
                <div className="text-white/30 text-xs uppercase tracking-widest font-medium mb-1">Legend</div>
                <div className="flex items-center gap-2"><div className="w-8 h-px bg-white/50" /><span className="text-white/50 text-xs">Replied</span></div>
                <div className="flex items-center gap-2"><div className="w-8 h-px bg-[#f0c060]/70" /><span className="text-[#f0c060]/70 text-xs">Asked</span></div>
                <span className="text-white/30 text-xs">Node size = speech count</span>
              </div>
            </div>
            {/* Heatmap */}
            <div style={{ position:"absolute", inset:0, opacity: activeTab==="heatmap"?1:0, pointerEvents: activeTab==="heatmap"?"auto":"none", transition:"opacity 0.15s" }}>
              <canvas ref={heatmapCanvasRef} style={{ display:"block", width:"100%", height:"100%" }} />
            </div>
            {/* Emotions */}
            <div style={{ position:"absolute", inset:0, opacity: activeTab==="emotions"?1:0, pointerEvents: activeTab==="emotions"?"auto":"none", transition:"opacity 0.15s" }}>
              <canvas ref={emotionsCanvasRef} style={{ display:"block", width:"100%", height:"100%" }} />
            </div>
          </div>

          {graphStats.length > 0 && activeTab === "graph" && (() => {
            const sorted = [...graphStats].sort((a, b) => b.speeches - a.speeches);
            const maxS = sorted[0]?.speeches || 1;
            const total = sorted.reduce((s, n) => s + n.speeches, 0) || 1;
            return (
              <div className="shrink-0 border-t border-white/10 px-3 py-2.5 space-y-1.5 bg-black/40">
                {sorted.map(n => (
                  <div key={n.id} className="flex items-center gap-2">
                    <span className="text-xs text-white/45 w-16 shrink-0 truncate">{n.id.split(" ")[0]}</span>
                    <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(n.speeches/maxS)*100}%`, backgroundColor: n.color }} />
                    </div>
                    <span className="text-xs font-bold w-10 text-right shrink-0" style={{ color: n.color }}>{Math.round((n.speeches/total)*100)}%</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Full-screen Book Conclusion ── */}
      {showConclusion && debate?.alternate_ending && (() => {
        const chars: string[] = debate.participating_characters?.map((c: any) => c.name || c) || [];
        const tl: any[] = debate.alternate_timeline || [];
        const turns: any[] = debate.transcript || [];
        const typeColor: Record<string, string> = {
          divergence:    "#c07820",
          turning_point: "#3b82f6",
          consequence:   "#78716c",
          resolution:    "#10b981",
        };
        const typeIcon: Record<string, string> = {
          divergence: "⟁", turning_point: "◈", consequence: "→", resolution: "✦",
        };
        return (
          <div className="absolute inset-0 z-50 overflow-y-auto" style={{ background: "#0d0b08" }}>

            {/* Sticky nav */}
            <div data-print-hide="true" className="sticky top-0 z-20 border-b border-white/8 flex items-center justify-between px-8 py-3" style={{ background: "rgba(13,11,8,0.92)", backdropFilter: "blur(12px)" }}>
              <span className="text-[#f0c060] font-bold text-sm tracking-wider">✦ WhatIfSabha</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExport}
                  className="text-xs text-white/70 hover:text-white border border-[#f0c060]/40 hover:border-[#f0c060]/70 px-3 py-1.5 rounded-lg transition-colors print:hidden"
                  aria-label="Export debate and alternate ending as PDF"
                >
                  📥 Export PDF
                </button>
                <Link href={`/story/${id}/debate`} className="text-xs text-white/40 hover:text-white/70 border border-white/10 hover:border-white/20 px-3 py-1.5 rounded-lg transition-colors">New debate →</Link>
                <button onClick={() => setShowConclusion(false)} className="text-xs text-white/40 hover:text-white/70 border border-white/10 hover:border-white/20 px-3 py-1.5 rounded-lg transition-colors">← Back</button>
              </div>
            </div>

            {/* HERO — dark, dramatic */}
            <div className="relative flex flex-col items-center justify-center text-center px-8 py-28 overflow-hidden" style={{ minHeight: "55vh" }}>
              <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 50%, rgba(192,120,32,0.14) 0%, transparent 70%)" }} />
              <div className="relative z-10 space-y-7 max-w-3xl">
                <div className="text-[#f0c060]/50 text-xs uppercase tracking-[0.45em] font-semibold">Alternate History</div>
                <h1 className="text-4xl sm:text-5xl font-bold leading-tight" style={{ color: "#f5f0e8" }}>
                  {debate.divergence_description}
                </h1>
                <div className="flex items-center justify-center gap-5 text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>
                  <span>{chars.length} characters</span>
                  <span style={{ color: "rgba(255,255,255,0.15)" }}>·</span>
                  <span>{turns.length} exchanges</span>
                  {tl.length > 0 && <><span style={{ color: "rgba(255,255,255,0.15)" }}>·</span><span>{tl.length} events</span></>}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  {chars.map((name: string, i: number) => (
                    <div key={name} className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10" style={{ background: "rgba(255,255,255,0.04)" }}>
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: CHAR_COLORS[i % CHAR_COLORS.length].hex }} />
                      <span className="text-xs" style={{ color: "rgba(255,255,255,0.6)" }}>{name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* TIMELINE */}
            {tl.length > 0 && (
              <div style={{ background: "#f7f3ed" }} className="py-20 px-8">
                <div className="max-w-3xl mx-auto">
                  <div className="text-center mb-14">
                    <div className="text-xs uppercase tracking-[0.35em] text-[#a09282] font-semibold mb-2">Timeline</div>
                    <div className="text-xl font-bold text-[#1c1410]">How this world unfolds</div>
                  </div>
                  <div className="relative">
                    <div className="absolute top-6 bottom-6 w-0.5 rounded-full" style={{ left: "23px", background: "linear-gradient(to bottom, #c07820, #e8e0d5 40%, #10b981)" }} />
                    <div className="space-y-6">
                      {tl.map((ev: any, i: number) => {
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
                                  <h3 className="font-bold text-[#1c1410] text-[15px] mt-0.5">{ev.label}</h3>
                                </div>
                                {ev.characters?.length > 0 && (
                                  <div className="flex flex-wrap gap-1 shrink-0">
                                    {(ev.characters as string[]).map((c: string) => {
                                      const ci = chars.indexOf(c);
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
              <div className="max-w-[660px] mx-auto px-8">
                <div className="text-center mb-14">
                  <div className="flex items-center justify-center gap-5 mb-8">
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                    <span className="text-[#c07820] text-xl">✦</span>
                    <div className="flex-1 h-px bg-[#e8e0d5]" />
                  </div>
                  <div className="text-xs uppercase tracking-[0.4em] text-[#a09282] font-semibold">The Alternate Ending</div>
                </div>
                <div className="text-[#2d1f14] leading-[2.15] text-[18px]" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                  <ReactMarkdown
                    components={{
                      p: ({ children, ...props }) => {
                        const node = (props as any).node as any;
                        const isFirst = node?.position?.start?.line === 1;
                        return isFirst
                          ? <p className="mb-8 first-letter:text-6xl first-letter:font-bold first-letter:float-left first-letter:mr-3 first-letter:leading-none first-letter:text-[#c07820]">{children}</p>
                          : <p className="mb-6 indent-8">{children}</p>;
                      },
                      em: ({ children }) => <em style={{ color: "#6b5c4e" }}>{children}</em>,
                      strong: ({ children }) => <strong style={{ color: "#1c1410", fontWeight: 600 }}>{children}</strong>,
                    }}
                  >{debate.alternate_ending}</ReactMarkdown>
                </div>
                <div className="mt-20 text-center space-y-2">
                  <div className="text-[#c07820] text-lg tracking-[0.5em]">✦ ✦ ✦</div>
                  <p className="text-xs text-[#a09282] mt-3">Shaped by {chars.join(", ")} · {turns.length} exchanges</p>
                </div>
              </div>
            </div>

            {/* ORACLE MODE */}
            {debate.alternate_world_state && (
              <div data-print-hide="true" style={{ background: "#0d0b08" }} className="py-24 px-8">
                <div className="max-w-2xl mx-auto space-y-8">
                  <div className="text-center space-y-3">
                    <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center text-[#f0c060] text-xl border border-[#f0c060]/25" style={{ background: "rgba(240,192,96,0.08)" }}>◉</div>
                    <div className="text-xs uppercase tracking-[0.35em] text-white/35 font-semibold">Oracle Mode</div>
                    <p className="text-white/50 text-sm max-w-sm mx-auto leading-relaxed">Enter the alternate world. Ask any character a question — they answer from inside this reality.</p>
                  </div>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {chars.map((name: string, ci: number) => {
                      const ccol = CHAR_COLORS[ci % CHAR_COLORS.length].hex;
                      const active = oracleCharacter === name && showOracle;
                      return (
                        <button key={name}
                          onClick={() => { setOracleCharacter(name); setShowOracle(true); setOracleHistory([]); }}
                          className="px-4 py-2 rounded-full text-sm font-medium transition-all border"
                          style={active ? { background: ccol, color: "#fff", borderColor: ccol } : { background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.55)", borderColor: "rgba(255,255,255,0.1)" }}>
                          {name}
                        </button>
                      );
                    })}
                  </div>
                  {showOracle && oracleCharacter && (
                    <div className="rounded-2xl overflow-hidden border border-white/10" style={{ background: "rgba(255,255,255,0.04)" }}>
                      <div className="px-5 py-3 border-b border-white/8 flex items-center gap-2.5">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex }} />
                        <span className="text-sm font-semibold text-white">{oracleCharacter}</span>
                        <span className="text-xs text-white/30 italic">· speaking from the alternate world</span>
                      </div>
                      <div className="px-5 py-4 space-y-4 max-h-96 overflow-y-auto">
                        {oracleHistory.length === 0 && <p className="text-sm text-white/25 italic text-center py-6">Ask {oracleCharacter} anything about their world…</p>}
                        {oracleHistory.map((msg, i) => (
                          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
                            {msg.role === "assistant" && (
                              <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border border-white/20" style={{ background: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex + "30", color: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex }}>{oracleCharacter[0]}</div>
                            )}
                            <div className={`rounded-xl px-4 py-2.5 text-sm max-w-[85%] leading-relaxed ${msg.role === "user" ? "rounded-br-sm font-medium" : "border border-white/10 rounded-bl-sm"}`}
                              style={msg.role === "user" ? { background: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" } : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)" }}>
                              {msg.content}
                            </div>
                          </div>
                        ))}
                        {oracleStreaming && (
                          <div className="flex gap-3">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 border border-white/20" style={{ background: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex + "30", color: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex }}>{oracleCharacter[0]}</div>
                            <div className="rounded-xl rounded-bl-sm px-4 py-2.5 text-sm border border-white/10 leading-relaxed" style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)" }}>{oracleStreaming}<span className="animate-pulse">▌</span></div>
                          </div>
                        )}
                      </div>
                      <div className="px-5 py-3 border-t border-white/8 flex gap-2">
                        <input value={oracleInput} onChange={e => setOracleInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendOracleQuestion()} placeholder={`Ask ${oracleCharacter}…`} className="flex-1 text-sm px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-white/20" style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.8)" }} />
                        <button onClick={sendOracleQuestion} disabled={oracleLoading || !oracleInput.trim()} className="px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-30" style={{ background: CHAR_COLORS[chars.indexOf(oracleCharacter) % CHAR_COLORS.length]?.hex, color: "#fff" }}>{oracleLoading ? "…" : "Ask"}</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Footer */}
            <div data-print-hide="true" className="border-t border-white/8 py-14 text-center" style={{ background: "#0d0b08" }}>
              <Link href={`/story/${id}/debate`} className="inline-flex items-center gap-2 px-8 py-3 text-sm font-bold rounded-xl transition-colors" style={{ background: "#f0c060", color: "#0d0b08" }}>
                Explore another what-if →
              </Link>
            </div>
          </div>
        );
      })()}
    </main>
  );
}
