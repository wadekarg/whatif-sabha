"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as d3 from "d3";
import bundledDebate from "../../public/debates/8654df3d-796a-4324-90c3-20d7986cb5de.json";
import { exportDebateToPdf } from "../lib/exportDebate";

const REPO_URL = "https://github.com/wadekarg/whatif-sabha";

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
type GraphNode = { id: string; x: number; y: number; vx: number; vy: number; r: number; color: string; speeches: number; role: string; shape: string; fx?: number | null; fy?: number | null; };
type SpeechAct   = "question" | "response" | "statement";
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

function BoruNotesTimeline({ history, latest, phase }: {
  history: { round: number; phase: string; note: string }[];
  latest?: string;
  phase?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = history && history.length
    ? history
    : (latest ? [{ round: 0, phase: phase || "", note: latest }] : []);
  if (entries.length === 0) return null;
  const reversed = [...entries].reverse();
  const visible = expanded ? reversed : reversed.slice(0, 1);
  return (
    <div className="bg-[#fef9f0] border border-[#f0c060]/30 rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm">🐘</span>
        <span className="text-[10px] text-[#c07820] uppercase tracking-widest font-semibold">Boru&apos;s Notes</span>
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

export default function DebateViewPage() {
  const [debate, setDebate]     = useState<any>(null);
  const [loading, setLoading]   = useState(true);
  const [showLegend, setShowLegend] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showConclusion, setShowConclusion] = useState(false);
  const [showOracle, setShowOracle] = useState(false);
  const [oracleCharacter, setOracleCharacter] = useState("");
  const [oracleInput, setOracleInput] = useState("");
  // Per-character oracle history — keyed by character name. Switching between
  // characters preserves each conversation for the session instead of wiping.
  const [oracleHistories, setOracleHistories] = useState<Record<string, {role:string;content:string;character?:string}[]>>({});
  const oracleHistory = oracleHistories[oracleCharacter] || [];
  const [oracleStreaming, setOracleStreaming] = useState("");
  const [oracleLoading, setOracleLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"graph"|"ledger"|"positions">("graph");
  const [graphLegendCollapsed, setGraphLegendCollapsed] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [graphHover, setGraphHover] = useState<{ x: number; y: number; source: string; target: string; count: number; questions: number; snippet: string } | null>(null);
  const [splitPct, setSplitPct] = useState(42);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef     = useRef(false);
  const bottomRef         = useRef<HTMLDivElement>(null);

  // Graph focus: click a node → spotlight its outgoing edges
  const focusedNodeIdRef = useRef<string | null>(null);
  const [, setFocusedNodeId] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [chatLoading, setChatLoading]   = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Graph (D3 SVG — matches the live debate page)
  const graphSvgRef     = useRef<SVGSVGElement>(null);
  const graphWrapperRef = useRef<HTMLDivElement>(null);
  const graphNodesRef   = useRef<GraphNode[]>([]);
  const graphEdgesRef   = useRef<GraphEdge[]>([]);
  const d3SimRef        = useRef<any>(null);
  const activeNodeRef   = useRef<string | null>(null);
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

  // Build graph from the bundled transcript (D3-friendly shape).
  // Matches the live page's sync logic.
  const buildGraph = (transcript: DebateEntry[], chars: string[]) => {
    const wrapper = graphWrapperRef.current;
    const W = wrapper?.clientWidth || 600, H = wrapper?.clientHeight || 400;

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
              id: name, x: W / 2, y: H / 2, vx: 0, vy: 0,
              r: 26, color: hex, speeches: 0,
              role: "speaker", shape: "circle",
            }
          : {
              id: name,
              x: W / 2 + Math.cos(angle) * dist + (Math.random() - 0.5) * 30,
              y: H / 2 + Math.sin(angle) * dist + (Math.random() - 0.5) * 30,
              vx: 0, vy: 0, r: 18, color: hex, speeches: 0,
              role: "neutral", shape: "circle",
            };
        graphNodesRef.current.push(node);
      }
      return node;
    };

    ensureNode("Boru");

    for (let i = 0; i < transcript.length; i++) {
      const entry = transcript[i];
      if ((entry as any).isReaction || (entry as any).isStageDirection) continue;

      if ((entry as any).isObserver) {
        const obsNode = ensureNode(entry.character);
        obsNode.speeches++;
        obsNode.r = Math.min(14 + obsNode.speeches * 0.5, 18);
        obsNode.shape = "square";
        obsNode.color = "#64748b";
        const primaryTarget = entry.target && entry.target !== entry.character ? entry.target : "Boru";
        ensureNode(primaryTarget);
        const existing = graphEdgesRef.current.find(e => e.sourceId === entry.character && e.targetId === primaryTarget);
        if (existing) { existing.count++; if (primaryTarget !== "Boru") existing.questions++; }
        else graphEdgesRef.current.push({
          source: entry.character, target: primaryTarget,
          sourceId: entry.character, targetId: primaryTarget,
          count: 1, questions: primaryTarget !== "Boru" ? 1 : 0,
        });
        continue;
      }

      if ((entry as any).isOrchestrator) {
        const boruNode = graphNodesRef.current.find(n => n.id === "Boru");
        if (boruNode) {
          boruNode.speeches++;
          boruNode.r = Math.min(26 + boruNode.speeches * 0.3, 34);
        }
        const allTargets: string[] = [];
        if ((entry as any).target_characters && Array.isArray((entry as any).target_characters)) {
          allTargets.push(...((entry as any).target_characters as string[]).filter(t => t !== "Boru" && t !== "all"));
        } else if ((entry as any).targets && Array.isArray((entry as any).targets)) {
          allTargets.push(...(entry as any).targets);
        } else if (entry.target && entry.target !== "Boru" && entry.target !== "all") {
          allTargets.push(entry.target);
        }
        for (const t of allTargets) {
          ensureNode(t);
          const existing = graphEdgesRef.current.find(e => e.sourceId === "Boru" && e.targetId === t);
          if (existing) { existing.count++; }
          else graphEdgesRef.current.push({
            source: "Boru", target: t,
            sourceId: "Boru", targetId: t,
            count: 1, questions: 0,
          });
        }
        continue;
      }

      const isAudience = (entry as any).isAudience;
      const lastNode = ensureNode(entry.character);
      if (!isAudience) {
        lastNode.speeches++;
        lastNode.r = Math.min(18 + lastNode.speeches * 1.5, 34);
      } else {
        lastNode.r = 12;
      }

      let allTargets: string[] = [];
      if (entry.target_characters && entry.target_characters.length > 0) {
        allTargets = entry.target_characters.filter(t => t !== entry.character && t !== "all");
      } else if (entry.target && entry.target !== "all") {
        allTargets = [entry.target];
      }
      if (allTargets.length === 0) {
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          const prev = transcript[j];
          if ((prev as any).isReaction || (prev as any).isStageDirection) continue;
          if ((prev as any).isOrchestrator) continue;
          if (!(prev as any).isObserver && !(prev as any).isAudience && prev.character !== entry.character) {
            allTargets = [prev.character];
            break;
          }
        }
        if (allTargets.length === 0) allTargets = ["Boru"];
      }

      const act = classifySpeechAct(
        entry.message,
        (entry.target_characters as string[] | undefined) ?? (entry.target ? [entry.target] : []),
      );
      const isQuestion = act === "question";

      for (const targetName of allTargets) {
        ensureNode(targetName);
        const existing = graphEdgesRef.current.find(e => e.sourceId === entry.character && e.targetId === targetName);
        if (existing) {
          existing.count++;
          if (isQuestion) existing.questions++;
        } else {
          graphEdgesRef.current.push({
            source: entry.character, target: targetName,
            sourceId: entry.character, targetId: targetName,
            count: 1, questions: isQuestion ? 1 : 0,
            speech_act: act,
          });
        }
      }
    }

    setGraphStats(graphNodesRef.current.map(n => ({ id: n.id, color: n.color, speeches: n.speeches })));
    if (d3SimRef.current && d3SimRef.current.update) d3SimRef.current.update();
  };

  // Load debate from bundled JSON — adapt {characters:[{name,...}]} to the live API
  // shape {participating_characters:[names]} so downstream rendering works unchanged.
  useEffect(() => {
    const src: any = bundledDebate;
    const names: string[] = (src.characters ?? [])
      .filter((c: any) => c?.role !== "orchestrator")
      .map((c: any) => c.name);
    const adapted: any = {
      ...src,
      participating_characters: names,
      divergence_description: src.story?.divergence ?? src.divergence_description ?? "",
      status: src.status ?? "completed",
      alternate_world_state: src.alternate_world_state ?? (src.alternate_ending ? {} : null),
    };
    setDebate(adapted);
    setLoading(false);
  }, []);

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

  // D3 force simulation + SVG rendering — identical to the live debate page.
  useEffect(() => {
    if (!debate) return;
    const svgEl = graphSvgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    const container = svgEl.parentElement!;
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;
    svg.attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();

    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "node-shadow-replay").attr("x", "-30%").attr("y", "-30%").attr("width", "160%").attr("height", "160%");
    filter.append("feDropShadow").attr("dx", 0).attr("dy", 1).attr("stdDeviation", 2).attr("flood-color", "#00000018");

    const g = svg.append("g");
    svg.call(d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on("zoom", (event) => g.attr("transform", event.transform)));

    const nodePath = (shape: string, r: number): string => {
      if (shape === "diamond") { const s = r * 1.3; return `M0,${-s} L${s},0 L0,${s} L${-s},0 Z`; }
      if (shape === "square") { const s = r * 0.95; return `M${-s},${-s} L${s},${-s} L${s},${s} L${-s},${s} Z`; }
      return `M${-r},0 A${r},${r} 0 1,1 ${r},0 A${r},${r} 0 1,1 ${-r},0 Z`;
    };

    const linkGroup = g.append("g").attr("class", "links");
    const nodeGroup = g.append("g").attr("class", "nodes");

    const safeEdges = () => {
      const nodeIds = new Set(graphNodesRef.current.map(n => n.id));
      return graphEdgesRef.current
        .filter(e => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId))
        .map(e => ({ source: e.sourceId, target: e.targetId, sourceId: e.sourceId, targetId: e.targetId, count: e.count, questions: e.questions }));
    };

    const simulation = d3.forceSimulation<GraphNode>(graphNodesRef.current)
      .force("charge", d3.forceManyBody<GraphNode>().strength((d: GraphNode) => -350 - d.r * 15).distanceMax(500))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide<GraphNode>().radius((d: GraphNode) => d.r + 40).strength(0.9).iterations(3))
      .force("x", d3.forceX<GraphNode>(W / 2).strength((d: GraphNode) => d.id === "Boru" ? 0.3 : 0.02))
      .force("y", d3.forceY<GraphNode>(H / 2).strength((d: GraphNode) => d.id === "Boru" ? 0.3 : 0.02))
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

      const edgeData = edges.filter(e => {
        const s = nodes.find(n => n.id === e.sourceId);
        const t = nodes.find(n => n.id === e.targetId);
        return s && t && isFinite(s.x) && isFinite(t.x);
      });

      const links = linkGroup.selectAll<SVGGElement, GraphEdge>("g.edge")
        .data(edgeData, (d: GraphEdge) => `${d.sourceId}->${d.targetId}`);

      const linksEnter = links.enter().append("g").attr("class", "edge");
      linksEnter.append("path").attr("fill", "none").attr("stroke-linecap", "round");
      linksEnter.append("polygon").attr("class", "arrow");
      linksEnter.append("text")
        .attr("font-size", 9).attr("font-weight", "bold")
        .attr("text-anchor", "middle").attr("dy", 3)
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
        const col = src.color;

        const el = d3.select(this);
        let pathsData = "";
        const mirrorOff = hasMirror ? 4 : 0;
        const responseCount = Math.min(e.count - e.questions, 6);
        const questionCount = Math.min(e.questions, 4);

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

        const labelX = 0.25 * sx0 + 0.5 * cpX0 + 0.25 * tx0;
        const labelY = 0.25 * sy0 + 0.5 * cpY0 + 0.25 * ty0;
        const labelText = isQ ? (e.questions === 1 ? "?" : `${e.questions}?`) : (e.count > 1 ? `${e.count}×` : "");
        el.select("text")
          .attr("x", labelX).attr("y", labelY)
          .attr("fill", col)
          .text(labelText);
      });

      const nodeData = nodes.filter(n => isFinite(n.x) && isFinite(n.y));
      const nodesSel = nodeGroup.selectAll<SVGGElement, GraphNode>("g.node")
        .data(nodeData, (d: GraphNode) => d.id);

      const nodesEnter = nodesSel.enter().append("g").attr("class", "node")
        .attr("filter", "url(#node-shadow-replay)")
        .style("cursor", "pointer")
        .on("click", (event, d) => {
          event.stopPropagation();
          const cur = focusedNodeIdRef.current;
          focusedNodeIdRef.current = cur === d.id ? null : d.id;
          setFocusedNodeId(focusedNodeIdRef.current);
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
      nodesEnter.append("circle").attr("class", "speaking-ring")
        .attr("fill", "none").attr("stroke-width", 2).attr("opacity", 0);
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

        el.select("circle.speaking-ring")
          .attr("r", d.r + 6)
          .attr("stroke", d.color)
          .attr("opacity", isActive ? 0.6 : 0);

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

    const updateSim = () => {
      simulation.nodes(graphNodesRef.current);
      const linkForce = simulation.force("link") as d3.ForceLink<GraphNode, any>;
      if (linkForce) linkForce.links(safeEdges());
      simulation.alpha(0.6).restart();
    };
    (d3SimRef as any).current = { sim: simulation, update: updateSim };
    if (graphNodesRef.current.length > 0) updateSim();

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

    svg.on("click", () => {
      if (focusedNodeIdRef.current) {
        focusedNodeIdRef.current = null;
        setFocusedNodeId(null);
        render();
      }
    });

    svg.on("mousemove", (event: MouseEvent) => {
      const [mx, my] = d3.pointer(event, g.node());
      const nodes = graphNodesRef.current;
      const edges = graphEdgesRef.current;
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
          const transcript: DebateEntry[] = debate?.transcript || [];
          const msgs = transcript.filter((e: any) => e.character === edge.sourceId && e.target === edge.targetId);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debate]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatLoading]);

  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q) return;
    setChatInput("");
    setChatMessages(prev => [
      ...prev,
      { role: "user", content: q },
      {
        role: "assistant",
        content:
          "The orchestrator chat needs the live backend. Clone the repo at " +
          REPO_URL +
          " to run the full app locally with your own API keys.",
      },
    ]);
  };

  const sendOracleQuestion = async () => {
    const q = oracleInput.trim();
    if (!q || !oracleCharacter) return;
    const targetChar = oracleCharacter;
    setOracleInput("");
    setOracleHistories(prev => ({
      ...prev,
      [targetChar]: [
        ...(prev[targetChar] || []),
        { role: "user", content: q, character: targetChar },
        {
          role: "assistant",
          content:
            "The Oracle needs the live backend. Clone the repo at " +
            REPO_URL +
            " to walk this world with your own API keys.",
          character: targetChar,
        },
      ],
    }));
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
      // Graph must be on screen to capture — flip to graph tab if needed,
      // wait a tick so D3 paints.
      if (activeTab !== "graph") setActiveTab("graph");
      await new Promise(r => setTimeout(r, 200));
      await exportDebateToPdf({
        graphElement: graphSvgRef.current,
        turns: transcript as any,
        meta: {
          storyTitle: debate.story?.title || debate.divergence_description || "Debate",
          storyAuthor: debate.story?.author,
          divergence: debate.divergence_description || "",
          exportedAt: new Date(),
          cast: chars.map((name, i) => ({
            name,
            color: CHAR_COLORS[i % CHAR_COLORS.length]?.hex,
          })),
          alternateEnding: debate.alternate_ending || undefined,
          ledgerSnapshot: debate.ledger_snapshot || undefined,
          positions: debate.ledger_snapshot?.positions || undefined,
        },
      });
    } catch (e) {
      console.error("Export failed:", e);
      alert("Export failed — see console for details.");
    }
  };

  return (
    <>
      {/* ── Debate sub-header (what-if banner) — sits below the TopNav ── */}
      <header className="sticky top-14 left-0 right-0 z-40 bg-[#f7f3ed]/95 backdrop-blur-md border-b border-[#e8e0d5]">
        <div className="bg-white/70 px-8 lg:px-12 py-2 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[10px] uppercase tracking-widest text-[#c07820] font-semibold shrink-0">What if</span>
            <p className="text-[#6b5c4e] text-xs truncate italic">"{debate.divergence_description}"</p>
          </div>
          {chars.length > 0 && (
            <div className="flex items-center shrink-0">
              {chars.map((name, i) => {
                const col = CHAR_COLORS[i % CHAR_COLORS.length].hex;
                return (
                  <div key={name} title={name}
                    className="-ml-1 w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-white font-bold text-[10px]"
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
      </header>

    <main className="relative flex flex-col bg-[#f7f3ed] overflow-hidden" style={{ height: "calc(100vh - 96px)" }}>
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
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-center text-xs text-[#a09282] hover:text-[#6b5c4e] transition-colors py-1"
                >
                  Start another debate →
                </a>
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

        {/* RIGHT: Visualization panel — matches the live debate page */}
        <div data-print-hide="true" className="flex flex-col overflow-hidden bg-[#f7f3ed]" style={{ flex: 1 }}>

          {/* Tab bar */}
          <div className="shrink-0 flex border-b border-[#e8e0d5] bg-[#f0ece5]">
            {(["graph", "ledger", "positions"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === tab ? "text-[#3d2f20] border-[#c07820]" : "text-[#a09282] border-transparent hover:text-[#6b5c4e]"
                }`}>
                {tab === "graph" ? "⬡ Graph" : tab === "ledger" ? "📋 Ledger" : "🎭 Positions"}
              </button>
            ))}
          </div>

          {/* Panel layers */}
          <div className="flex-1 relative min-h-0">
            {/* Graph */}
            <div ref={graphWrapperRef} style={{ position:"absolute", inset:0, opacity: activeTab==="graph" ? 1 : 0, pointerEvents: activeTab==="graph" ? "auto" : "none", transition:"opacity 0.15s", background: "#ffffff" }}>
              <svg ref={graphSvgRef} style={{ display:"block", width:"100%", height:"100%" }} />
              {graphHover && (
                <div className="absolute pointer-events-none z-10 max-w-[220px]"
                  style={{ left: graphHover.x + 14, top: graphHover.y - 8 }}>
                  <div className="rounded-xl border border-[#e0d8ce] shadow-xl px-3 py-2.5 space-y-1.5" style={{ background: "rgba(255,252,248,0.97)", backdropFilter: "blur(8px)" }}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold" style={{ color: CHAR_COLORS[(debate?.participating_characters || []).indexOf(graphHover.source) % CHAR_COLORS.length]?.hex }}>{graphHover.source}</span>
                      <span className="text-[#a09282] text-xs">→</span>
                      <span className="text-xs font-bold" style={{ color: CHAR_COLORS[(debate?.participating_characters || []).indexOf(graphHover.target) % CHAR_COLORS.length]?.hex }}>{graphHover.target}</span>
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

            {/* Argument Ledger */}
            <div className="overflow-y-auto p-3 space-y-2" style={{ position:"absolute", inset:0, opacity: activeTab==="ledger" ? 1 : 0, pointerEvents: activeTab==="ledger" ? "auto" : "none", transition:"opacity 0.15s" }}>
              {(() => {
                const snap = debate?.ledger_snapshot || {};
                const progress: string = snap.progress || "";
                const progressHistory: { round: number; phase: string; note: string }[] = snap.progress_history || [];
                const openQs: any[] = snap.open_questions || [];
                const resolvedQs: any[] = snap.resolved_questions || [];
                const claims: any[] = snap.claims || [];
                const hasAnything = progress || progressHistory.length || openQs.length || resolvedQs.length || claims.length;
                if (!hasAnything) {
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <span className="text-2xl mb-2">🐘</span>
                      <p className="text-sm text-[#a09282]">No ledger was recorded for this debate.</p>
                    </div>
                  );
                }
                return (
                  <>
                    <BoruNotesTimeline history={progressHistory} latest={progress} />


                    <LedgerSection
                      title="Open Questions"
                      count={openQs.length}
                      badge={<span className="text-amber-600">{openQs.filter((q: any) => q.status === "unanswered").length} unanswered</span>}
                      defaultOpen={true}
                      empty="No open questions recorded"
                    >
                      {openQs.map((q: any, i: number) => (
                        <div key={q.id ?? i} className={`border rounded-lg overflow-hidden ${q.status === "unanswered" ? "border-amber-200" : "border-[#e8e0d5]"}`}>
                          <div className={`px-3 py-2 ${q.status === "unanswered" ? "bg-amber-50/60" : "bg-white"}`}>
                            <p className="text-xs text-[#1c1410] leading-relaxed font-medium">{q.question}</p>
                            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[#a09282]">
                              <span>Asked by <span className="font-medium text-[#6b5c4e]">{q.asked_by}</span></span>
                              {q.directed_to?.length > 0 && (<><span>→</span><span className="font-medium text-[#6b5c4e]">{q.directed_to.join(", ")}</span></>)}
                              <span className={`ml-auto px-1.5 py-0.5 rounded font-medium ${q.status === "unanswered" ? "text-amber-700 bg-amber-100" : q.status === "resolved" ? "text-emerald-700 bg-emerald-50" : "text-blue-600 bg-blue-50"}`}>{q.status}</span>
                            </div>
                          </div>
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

                    {resolvedQs.length > 0 && (
                      <LedgerSection title="Resolved" count={resolvedQs.length} badge={<span className="text-emerald-600">✓</span>} defaultOpen={false} empty="">
                        {resolvedQs.map((q: any, i: number) => (
                          <div key={q.id ?? i} className="border border-emerald-200 rounded-lg overflow-hidden">
                            <div className="px-3 py-2 bg-emerald-50/40">
                              <p className="text-xs text-[#6b5c4e] leading-relaxed line-through decoration-emerald-300">{q.question}</p>
                            </div>
                          </div>
                        ))}
                      </LedgerSection>
                    )}

                    {claims.length > 0 && (
                      <LedgerSection title="Claims & Disputes" count={claims.length} badge={<span className="text-[#c07820]">{claims.filter((c: any) => c.status === "disputed").length} disputed</span>} defaultOpen={true} empty="">
                        {claims.map((c: any, i: number) => (
                          <div key={i} className={`border rounded-lg px-3 py-2 ${c.status === "disputed" ? "border-red-200 bg-red-50/30" : c.status === "resolved" ? "border-emerald-200 bg-emerald-50/20" : "border-[#e8e0d5] bg-white"}`}>
                            <div className="flex items-start gap-1.5">
                              <span className="text-xs font-bold text-[#1c1410] shrink-0">{c.character}:</span>
                              <span className="text-xs text-[#6b5c4e] leading-relaxed">&ldquo;{c.claim}&rdquo;</span>
                            </div>
                          </div>
                        ))}
                      </LedgerSection>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Character Positions */}
            <div className="overflow-y-auto p-4 space-y-3" style={{ position:"absolute", inset:0, opacity: activeTab==="positions" ? 1 : 0, pointerEvents: activeTab==="positions" ? "auto" : "none", transition:"opacity 0.15s" }}>
              {(() => {
                const positions: Record<string, string> = debate?.ledger_snapshot?.positions || {};
                const chars: string[] = debate?.participating_characters || [];
                const entries = chars.map((name, i) => ({ name, i, pos: positions[name] })).filter(x => x.pos);
                if (entries.length === 0) {
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <span className="text-2xl mb-2">🎭</span>
                      <p className="text-sm text-[#a09282]">No character positions recorded.</p>
                    </div>
                  );
                }
                return entries.map(({ name, i, pos }) => {
                  const col = CHAR_COLORS[i % CHAR_COLORS.length];
                  const stats = graphStats.find(g => g.id === name);
                  return (
                    <div key={name} className="bg-white border border-[#e8e0d5] rounded-xl p-3.5">
                      <div className="flex items-center gap-2.5 mb-2">
                        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white font-bold text-xs" style={{ backgroundColor: col.hex }}>
                          {name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-semibold text-[#1c1410]">{name}</span>
                        </div>
                        {stats && (<span className="text-[10px] text-[#c8b89a] shrink-0">{stats.speeches} turns</span>)}
                      </div>
                      <p className="text-xs text-[#6b5c4e] leading-relaxed">{pos}</p>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* Voice share */}
          {graphStats.length > 0 && activeTab === "graph" && (() => {
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
                <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-xs text-white/40 hover:text-white/70 border border-white/10 hover:border-white/20 px-3 py-1.5 rounded-lg transition-colors">New debate →</a>
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
                          onClick={() => { setOracleCharacter(name); setShowOracle(true); /* no wipe — per-character history persists for the session */ }}
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
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-8 py-3 text-sm font-bold rounded-xl transition-colors" style={{ background: "#f0c060", color: "#0d0b08" }}>
                Explore another what-if →
              </a>
            </div>
          </div>
        );
      })()}
    </main>

    {/* ── Footer — same as the home page ── */}
    <footer className="bg-[#faf7f2] border-t border-[#e8e0d5] py-8 px-6">
      <div className="max-w-2xl mx-auto flex flex-col items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-[#c07820] flex items-center justify-center">
            <span style={{ color: "#fef9c3", fontSize: "18px", lineHeight: 1 }}>☸</span>
          </div>
          <span className="font-bold text-sm text-[#1c1410]">WhatIf<span className="text-[#c07820]">Sabha</span></span>
        </div>
        <p className="text-xs text-[#a09282] text-center leading-relaxed max-w-md">
          Upload any book. Watch the characters debate what would have happened differently.
          A curiosity-driven side project — debate engine powered by multiple LLM providers.
        </p>
        <div className="flex items-center gap-4">
          <a href="https://github.com/wadekarg/whatif-sabha" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-[#6b5c4e] hover:text-[#c07820] transition-colors">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
          </a>
          <span className="text-[#e8e0d5]">|</span>
          <a href="https://github.com/wadekarg" target="_blank" rel="noopener noreferrer"
            className="text-xs text-[#6b5c4e] hover:text-[#c07820] transition-colors">
            Built by @wadekarg
          </a>
          <span className="text-[#e8e0d5]">|</span>
          <span className="text-xs text-[#c8b89a]">MIT License</span>
        </div>
      </div>
    </footer>
    </>
  );
}
