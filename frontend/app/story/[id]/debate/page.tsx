"use client";

import { useState, useRef, useEffect, useCallback } from "react";
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

type DebateEntry = { character: string; message: string; round: number; target?: string; };
type StreamEntry = { character: string; text: string; };
type DivPoint    = { event_id: string; description: string; affected_characters: string[]; };

type GraphNode = { id: string; x: number; y: number; vx: number; vy: number; r: number; color: string; speeches: number; };
type GraphEdge = { source: string; target: string; count: number; questions: number; };

export default function DebatePage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [divergence, setDivergence] = useState(() => searchParams.get("q") || "");
  const [suggestions, setSuggestions] = useState<DivPoint[]>([]);
  const [transcript, setTranscript] = useState<DebateEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamEntry | null>(null);
  const [alternateEnding, setAlternateEnding] = useState("");
  const [streamingEnding, setStreamingEnding] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "done">("idle");
  const [dramaScore, setDramaScore] = useState(0.5);
  const [activeCharacters, setActiveCharacters] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [chatMessages, setChatMessages] = useState<{role:"user"|"assistant";content:string}[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [chatLoading, setChatLoading]   = useState(false);
  const [debateId, setDebateId]         = useState<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Interaction graph
  const graphCanvasRef    = useRef<HTMLCanvasElement>(null);
  const graphNodesRef     = useRef<GraphNode[]>([]);
  const graphEdgesRef     = useRef<GraphEdge[]>([]);
  const graphAnimRef      = useRef<number>(0);
  const activeNodeRef     = useRef<string | null>(null); // currently speaking
  const [graphStats, setGraphStats] = useState<{id: string; color: string; speeches: number}[]>([]);

  useEffect(() => {
    fetch(`${API}/stories/${id}/divergence-points`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setSuggestions(d))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, streaming]);

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
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.008; n.vy += (cy - n.y) * 0.008;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(n.r + 12, Math.min(W - n.r - 12, n.x));
        n.y = Math.max(n.r + 12, Math.min(H - n.r - 12, n.y));
      }

      // ── Draw ──
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#09090b"; ctx.fillRect(0, 0, W, H);

      // Edges
      for (const e of edges) {
        const src = nodes.find(n => n.id === e.source);
        const tgt = nodes.find(n => n.id === e.target);
        if (!src || !tgt) continue;

        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const ux = dx/d, uy = dy/d;

        // Curve bidirectional edges so they don't overlap
        const hasMirror = edges.some(e2 => e2.source === e.target && e2.target === e.source);
        const curveOffset = hasMirror ? 22 : 0;
        const perpX = -uy * curveOffset, perpY = ux * curveOffset;
        const mx = (src.x + tgt.x)/2 + perpX, my = (src.y + tgt.y)/2 + perpY;

        // Adjust start/end to circle edges using bezier tangent
        const sxe = src.x + ux * src.r, sye = src.y + uy * src.r;
        const txe = tgt.x - ux * tgt.r - perpX*0.3, tye = tgt.y - uy * tgt.r - perpY*0.3;

        const isQ = e.questions > 0;
        const lineW = Math.min(1.5 + e.count * 1.2, 6);
        const alpha = Math.min(0.4 + e.count * 0.12, 0.9);
        const col = isQ ? "#f0c060" : src.color;

        ctx.save();
        if (isQ) { ctx.setLineDash([6, 4]); }
        ctx.beginPath();
        ctx.moveTo(sxe, sye);
        ctx.quadraticCurveTo(mx, my, txe, tye);
        ctx.strokeStyle = col + Math.round(alpha * 255).toString(16).padStart(2,"0");
        ctx.lineWidth = lineW;
        ctx.stroke();
        if (isQ) ctx.setLineDash([]);
        ctx.restore();

        // Arrowhead at target
        const arrowDx = txe - mx, arrowDy = tye - my;
        const arrowD = Math.sqrt(arrowDx*arrowDx + arrowDy*arrowDy) || 1;
        const aUx = arrowDx/arrowD, aUy = arrowDy/arrowD;
        ctx.fillStyle = col + Math.round(alpha * 255).toString(16).padStart(2,"0");
        drawArrow(ctx, txe, tye, aUx, aUy, 7);

        // Label at midpoint: type + count
        const label = e.questions > 0 ? `asked ×${e.count}` : `replied ×${e.count}`;
        ctx.font = "bold 9px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        // Small pill background
        const lw = ctx.measureText(label).width + 8;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(mx - lw/2, my - 7, lw, 14, 4);
        } else {
          ctx.rect(mx - lw/2, my - 7, lw, 14);
        }
        ctx.fill();
        ctx.fillStyle = isQ ? "#f0c060cc" : col + "cc";
        ctx.fillText(label, mx, my);
      }

      // Nodes
      const active = activeNodeRef.current;
      const pulse = Math.sin(frame * 0.08) * 0.5 + 0.5; // 0..1

      for (const n of nodes) {
        const isActive = n.id === active;

        // Glow
        const glowR = n.r * (isActive ? 2.8 + pulse * 0.8 : 2);
        const grd = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, glowR);
        grd.addColorStop(0, n.color + (isActive ? "66" : "33"));
        grd.addColorStop(1, "transparent");
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, 2*Math.PI);
        ctx.fillStyle = grd; ctx.fill();

        // Shadow
        ctx.beginPath(); ctx.arc(n.x + 2, n.y + 3, n.r, 0, 2*Math.PI);
        ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fill();

        // Circle
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 2*Math.PI);
        ctx.fillStyle = n.color; ctx.fill();

        // Ring for active speaker
        if (isActive) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + pulse * 3, 0, 2*Math.PI);
          ctx.strokeStyle = n.color + "99"; ctx.lineWidth = 2; ctx.stroke();
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
        ctx.fillStyle = isActive ? "#ffffff" : "rgba(255,255,255,0.65)";
        ctx.fillText(name, n.x, n.y + n.r + 4);

        // Speech count badge
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

      if (nodes.length === 0) {
        ctx.font = "13px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.fillText("Waiting for debate to begin…", W/2, H/2);
      }

      graphAnimRef.current = requestAnimationFrame(tick);
    };

    graphAnimRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(graphAnimRef.current); window.removeEventListener("resize", resize); };
  }, [status]);

  const startDebate = async () => {
    if (!divergence.trim()) return;
    setStatus("starting");
    graphNodesRef.current = [];
    graphEdgesRef.current = [];
    const res = await fetch(`${API}/debates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ story_id: id, divergence_description: divergence }),
    });
    const data = await res.json();
    setDebateId(data.debate_id);
    setActiveCharacters(data.characters);
    setStatus("running");

    const es = new EventSource(`${API}/debates/${data.debate_id}/stream`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "character_start") {
        setStreaming({ character: ev.character, text: "" });
        setDramaScore(ev.drama_score || 0.5);
      } else if (ev.type === "token") {
        setStreaming(prev => prev ? { ...prev, text: prev.text + ev.text } : null);
      } else if (ev.type === "character_end") {
        setTranscript(prev => [...prev, {
          character: ev.character,
          message: ev.message,
          round: ev.round || 0,
          target: ev.target_character || undefined,
        }]);
        setStreaming(null);
      } else if (ev.type === "ending_token") {
        setStreamingEnding(prev => prev + ev.text);
      } else if (ev.type === "debate_end") {
        setAlternateEnding(ev.alternate_ending);
        setStreamingEnding("");
        setStatus("done");
        es.close();
      }
    };
    es.onerror = () => es.close();
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
      <main className="flex-1 flex flex-col bg-[#f7f3ed]">
        <div className="bg-white border-b border-[#e8e0d5]">
          <div className="max-w-2xl mx-auto px-6 py-4 flex items-center gap-3">
            <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors">
              ← Back
            </Link>
          </div>
        </div>

        <div className="flex-1 flex items-start justify-center p-8 pt-12">
          <div className="max-w-xl w-full space-y-8 animate-fade-up">
            <div className="text-center space-y-3">
              <div className="text-xs font-semibold tracking-[0.25em] text-[#c07820] bg-[#fef3e2] border border-[#f0c060]/50 px-4 py-1.5 rounded-full uppercase inline-block">
                Sabha — The Great Debate
              </div>
              <h1 className="text-4xl font-bold text-[#1c1410] leading-tight">
                What if things had<br />gone <span className="ink-shimmer">differently?</span>
              </h1>
              <p className="text-[#6b5c4e] leading-relaxed">
                Describe the alternate scenario. The characters will take it from there.
              </p>
            </div>

            <div className="bg-white rounded-2xl border-2 border-[#e8e0d5] focus-within:border-[#c07820] transition-colors overflow-hidden">
              <div className="px-5 pt-4 pb-1">
                <div className="text-xs font-semibold text-[#c07820] uppercase tracking-widest mb-2">What if...</div>
                <textarea
                  value={divergence}
                  onChange={(e) => setDivergence(e.target.value)}
                  placeholder="Boxer refused to go to the slaughterhouse and led a revolt against Napoleon..."
                  className="w-full bg-transparent resize-none h-28 text-[#1c1410] placeholder-[#c8b89a] focus:outline-none text-base leading-relaxed"
                />
              </div>
              <div className="px-5 py-3 bg-[#faf7f2] border-t border-[#e8e0d5] flex items-center justify-between">
                <span className="text-xs text-[#a09282]">
                  {divergence.length > 0 ? `${divergence.length} chars` : "Describe an alternate scenario"}
                </span>
                <button
                  onClick={startDebate}
                  disabled={!divergence.trim() || status === "starting"}
                  className="flex items-center gap-2 bg-[#c07820] hover:bg-[#a86a18] disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold px-5 py-2 rounded-xl transition-all text-sm shadow-sm"
                >
                  {status === "starting" ? (
                    <><span className="animate-breathe">⚡</span> Starting...</>
                  ) : (
                    <><span>⚡</span> Begin Sabha</>
                  )}
                </button>
              </div>
            </div>

            {suggestions.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-[#a09282] uppercase tracking-widest font-medium">
                  <span className="w-4 h-px bg-[#e8e0d5]" />
                  Story suggests
                  <span className="w-4 h-px bg-[#e8e0d5]" />
                </div>
                {suggestions.map((s) => (
                  <button
                    key={s.event_id}
                    onClick={() => setDivergence(s.description)}
                    className={`w-full text-left text-sm px-4 py-3 rounded-xl border transition-all duration-200 ${
                      divergence === s.description
                        ? "border-[#c07820] bg-[#fef3e2] text-[#1c1410]"
                        : "border-[#e8e0d5] bg-white text-[#6b5c4e] hover:border-[#c07820]/40 hover:bg-[#fef3e2]/50"
                    }`}
                  >
                    <span className="text-[#c07820] mr-2 font-bold">→</span>
                    {s.description}
                    {s.affected_characters.length > 0 && (
                      <span className="ml-2 text-[#a09282] text-xs">· {s.affected_characters.join(", ")}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  /* ── DEBATE SCREEN ── */
  return (
    <main className="flex-1 flex flex-col bg-[#f7f3ed] overflow-hidden">
      {/* Sticky sub-header */}
      <div className="sticky top-14 z-40 border-b border-[#e8e0d5] bg-white/95 backdrop-blur-sm shrink-0">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[#c07820] font-bold text-sm shrink-0">Sabha</span>
            <span className="text-[#c8b89a]">·</span>
            <p className="text-[#6b5c4e] text-xs truncate italic">"{divergence}"</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <span className="text-xs text-[#a09282]">Drama</span>
            <div className="w-16 h-1.5 bg-[#e8e0d5] rounded-full overflow-hidden">
              <div className="h-full bg-[#c07820] rounded-full transition-all duration-700" style={{ width: `${dramaScore * 100}%` }} />
            </div>
            {status === "done" && (
              <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full ml-1 font-medium">done</span>
            )}
          </div>
        </div>
      </div>

      {/* Two-column: transcript + graph */}
      <div className="flex-1 grid grid-cols-[1fr_420px] overflow-hidden">

        {/* Transcript */}
        <div className="overflow-y-auto px-6 py-6 space-y-1 border-r border-[#e8e0d5]">
          {transcript.map((entry, i) => {
            const c = colorOf(entry.character);
            return (
              <div key={i} className="flex gap-3 py-2.5 animate-fade-up" style={{ animationDelay: "0s", opacity: 1 }}>
                <div className={`w-8 h-8 rounded-full ${c.bg} shrink-0 flex items-center justify-center text-white font-bold text-xs mt-0.5 ring-2 ring-offset-2 ring-offset-[#f7f3ed] ${c.ring}`}>
                  {initials(entry.character)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-semibold mb-1 ${c.text}`}>{entry.character}</div>
                  <div className="text-[#6b5c4e] text-sm leading-relaxed">{entry.message}</div>
                </div>
              </div>
            );
          })}

          {streaming && (() => {
            const c = colorOf(streaming.character);
            return (
              <div className="flex gap-3 py-2.5">
                <div className={`w-8 h-8 rounded-full ${c.bg} shrink-0 flex items-center justify-center text-white font-bold text-xs mt-0.5 animate-breathe ring-2 ring-offset-2 ring-offset-[#f7f3ed] ${c.ring}`}>
                  {initials(streaming.character)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-semibold mb-1 ${c.text}`}>
                    {streaming.character} <span className="animate-breathe opacity-60 not-italic">▌</span>
                  </div>
                  <div className="text-[#6b5c4e] text-sm leading-relaxed">{streaming.text}</div>
                </div>
              </div>
            );
          })()}

          {(streamingEnding || alternateEnding) && (
            <div className="mt-8 pt-8 border-t border-[#e8e0d5] space-y-4 animate-fade-up">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-[#c07820] text-sm">✍</div>
                <h3 className="font-bold text-[#1c1410] text-lg">The Alternate Ending</h3>
              </div>
              <div className="bg-white border border-[#e8e0d5] rounded-2xl p-6 text-[#6b5c4e] text-sm leading-[1.9] whitespace-pre-wrap italic">
                {alternateEnding || streamingEnding}
                {streamingEnding && !alternateEnding && (
                  <span className="animate-breathe not-italic text-[#c07820]">▌</span>
                )}
              </div>
              {status === "done" && (
                <Link
                  href={`/story/${id}/debate`}
                  className="inline-block text-xs text-[#6b5c4e] hover:text-[#1c1410] border border-[#e8e0d5] hover:border-[#c8b89a] px-4 py-2 rounded-lg transition-colors bg-white"
                >
                  Start another debate →
                </Link>
              )}
            </div>
          )}

          <div ref={bottomRef} className="h-8" />
        </div>

        {/* Right column: graph + chat */}
        <div className="flex flex-col overflow-hidden border-l border-[#e8e0d5]">

          {/* Live interaction graph — top portion */}
          <div className="relative bg-[#09090b] overflow-hidden flex flex-col" style={{ flex: "1 1 0" }}>
            <div className="flex-1 relative">
              <canvas ref={graphCanvasRef} className="w-full h-full" style={{ display: "block" }} />

              {/* Legend overlay */}
              <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm border border-white/10 rounded-xl px-3 py-2.5 space-y-1.5">
                <div className="text-white/30 text-[9px] uppercase tracking-widest font-medium mb-1">Legend</div>
                <div className="flex items-center gap-2">
                  <div className="w-8 h-px bg-white/50" />
                  <span className="text-white/50 text-[10px]">Replied</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-8 h-px border-t border-dashed border-[#f0c060]/70" />
                  <span className="text-[#f0c060]/70 text-[10px]">Asked</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-white/30 text-[9px]">Node size = speech count</span>
                </div>
              </div>
            </div>

            {/* Stats bar */}
            {graphStats.length > 0 && (
              <div className="shrink-0 border-t border-white/10 px-3 py-2.5 flex gap-3 overflow-x-auto bg-black/40">
                {[...graphStats]
                  .sort((a, b) => b.speeches - a.speeches)
                  .map(n => (
                    <div key={n.id} className="flex items-center gap-1.5 shrink-0">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: n.color }} />
                      <span className="text-[11px] text-white/55">{n.id.split(" ")[0]}</span>
                      <span className="text-[11px] font-bold" style={{ color: n.color }}>{n.speeches}</span>
                    </div>
                  ))
                }
              </div>
            )}
          </div>

          {/* Debate chat — bottom portion */}
          <div className="flex flex-col bg-white border-t border-[#e8e0d5]" style={{ height: "300px" }}>
            {/* Header */}
            <div className="px-4 py-2.5 border-b border-[#e8e0d5] shrink-0 flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-xs text-[#c07820]">✦</div>
              <span className="text-sm font-semibold text-[#1c1410]">Ask the Orchestrator</span>
              <span className="text-xs text-[#a09282] ml-1">about this debate</span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {chatMessages.length === 0 && (
                <div className="space-y-1.5 pt-1">
                  {["Why did they say that?", "Who has the upper hand?", "What happens next?"].map(q => (
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
                    <div className="w-5 h-5 rounded-md bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-[10px] shrink-0 mr-1.5 mt-0.5">✦</div>
                  )}
                  <div className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                    m.role === "user"
                      ? "bg-[#c07820] text-white rounded-br-sm"
                      : "bg-[#f7f3ed] text-[#1c1410] border border-[#e8e0d5] rounded-bl-sm"
                  }`}>
                    {m.role === "assistant" ? (
                      <ReactMarkdown components={{
                        p: ({children}) => <p className="mb-1 last:mb-0">{children}</p>,
                        strong: ({children}) => <strong className="font-semibold">{children}</strong>,
                        h3: ({children}) => <p className="font-semibold mt-2 mb-0.5">{children}</p>,
                        h2: ({children}) => <p className="font-semibold mt-2 mb-0.5">{children}</p>,
                        ul: ({children}) => <ul className="list-disc list-outside pl-4 space-y-0.5">{children}</ul>,
                        ol: ({children}) => <ol className="list-decimal list-outside pl-4 space-y-0.5">{children}</ol>,
                        li: ({children}) => <li>{children}</li>,
                      }}>{typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as {text?:string}[]).map(b => b?.text ?? "").join("") : String(m.content)}</ReactMarkdown>
                    ) : (
                      typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as {text?:string}[]).map(b => b?.text ?? "").join("") : String(m.content)
                    )}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="w-5 h-5 rounded-md bg-[#fef3e2] border border-[#f0c060] flex items-center justify-center text-[10px] shrink-0 mr-1.5 mt-0.5">✦</div>
                  <div className="bg-[#f7f3ed] border border-[#e8e0d5] px-3 py-2 rounded-xl rounded-bl-sm flex gap-1 items-center h-8">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay:"0ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay:"300ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-[#c8b89a] animate-breathe" style={{ animationDelay:"600ms" }} />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
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
              >
                ↑
              </button>
            </div>
          </div>

        </div>

      </div>
    </main>
  );
}
