"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8001";

const ROLE_COLORS: Record<string, string> = {
  protagonist: "#c07820",
  antagonist:  "#ef4444",
  supporting:  "#3b82f6",
  neutral:     "#78716c",
};
const EDGE_COLORS: Record<string, string> = {
  ally:    "#22c55e",
  enemy:   "#ef4444",
  rival:   "#f97316",
  mentor:  "#a855f7",
  neutral: "#a8a29e",
  family:  "#06b6d4",
};
const ROLE_STYLE: Record<string, string> = {
  protagonist: "text-[#c07820] border-[#c07820]/40 bg-[#c07820]/10",
  antagonist:  "text-red-400 border-red-400/40 bg-red-400/10",
  supporting:  "text-blue-400 border-blue-400/40 bg-blue-400/10",
  neutral:     "text-white/50 border-white/20 bg-white/5",
};

type Node = { id: string; name: string; role: string; description?: string; importance: number;
              x: number; y: number; vx: number; vy: number; color: string; r: number; };
type Edge = { source: string; target: string; type: string; color: string; strength: number; };

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t  = dx*dx + dy*dy === 0 ? 0 : Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)));
  return Math.sqrt((px - (ax + t*dx))**2 + (py - (ay + t*dy))**2);
}

export default function GraphPage() {
  const { id } = useParams<{ id: string }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef  = useRef<Node[]>([]);
  const edgesRef  = useRef<Edge[]>([]);
  const animRef   = useRef<number>(0);
  const [selected,     setSelected]     = useState<Node | null>(null);
  const [selectedData, setSelectedData] = useState<any>(null);
  const [activePhase,      setActivePhase]      = useState(0);
  const [showFairWitness,  setShowFairWitness]  = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [hoveredEdge,  setHoveredEdge]  = useState<{ edge: Edge; sx: number; sy: number } | null>(null);
  const [legendPos,  setLegendPos]  = useState({ x: 16, y: 16 });
  const [legendOpen, setLegendOpen] = useState(true);
  const legendDrag     = useRef<{ ox: number; oy: number } | null>(null);
  const legendPosRef   = useRef({ x: 16, y: 16 });
  const legendOpenRef  = useRef(true);
  const LEGEND_W = 168, LEGEND_H_OPEN = 244, LEGEND_H_CLOSED = 36;

  const pan      = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const dragging   = useRef<{ node: Node; ox: number; oy: number } | null>(null);
  const isPanning  = useRef(false);
  const panStart   = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const mouseDown  = useRef<{ sx: number; sy: number } | null>(null);

  useEffect(() => { legendPosRef.current  = legendPos;  }, [legendPos]);
  useEffect(() => { legendOpenRef.current = legendOpen; }, [legendOpen]);

  const toWorld = (sx: number, sy: number) => ({
    x: (sx - pan.current.x) / scaleRef.current,
    y: (sy - pan.current.y) / scaleRef.current,
  });

  // Fetch graph data
  useEffect(() => {
    fetch(`${API}/stories/${id}/graph`)
      .then(r => r.json())
      .then(data => {
        const W = window.innerWidth, H = window.innerHeight;
        nodesRef.current = (data.nodes || []).map((n: any) => ({
          id: n.id || n.name, name: n.name, role: n.role || "neutral",
          description: n.description, importance: n.importance || 0.5,
          x: W / 2 + (Math.random() - 0.5) * 80,
          y: H / 2 + (Math.random() - 0.5) * 80,
          vx: 0, vy: 0,
          color: ROLE_COLORS[n.role] || ROLE_COLORS.neutral,
          r: Math.round((n.importance || 0.5) * 14) + 6,
        }));
        edgesRef.current = (data.edges || []).map((e: any) => ({
          source: e.source, target: e.target,
          type: e.type, strength: e.strength || 0.5,
          color: EDGE_COLORS[e.type] || EDGE_COLORS.neutral,
        }));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  // Fetch full character data when selected
  useEffect(() => {
    if (!selected) { setSelectedData(null); return; }
    setSelectedData(null);
    setActivePhase(0);
    setShowFairWitness(false);
    fetch(`${API}/stories/${id}/characters/${encodeURIComponent(selected.name)}`)
      .then(r => r.json())
      .then(setSelectedData)
      .catch(() => setSelectedData(null));
  }, [selected, id]);

  // Physics + render loop
  useEffect(() => {
    if (loading) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight - 56; };
    resize();
    window.addEventListener("resize", resize);

    const tick = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const W = canvas.width, H = canvas.height;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
          const d2 = dx*dx + dy*dy + 1;
          const f  = 800 / d2;
          nodes[i].vx -= dx*f; nodes[i].vy -= dy*f;
          nodes[j].vx += dx*f; nodes[j].vy += dy*f;
        }
      }
      for (const e of edges) {
        const src = nodes.find(n => n.id === e.source || n.name === e.source);
        const tgt = nodes.find(n => n.id === e.target || n.name === e.target);
        if (!src || !tgt) continue;
        const dx = tgt.x - src.x, dy = tgt.y - src.y;
        const d  = Math.sqrt(dx*dx + dy*dy) || 1;
        const ideal = 30 + (src.r + tgt.r);
        const f  = (d - ideal) * 0.03 * e.strength;
        src.vx += (dx/d)*f; src.vy += (dy/d)*f;
        tgt.vx -= (dx/d)*f; tgt.vy -= (dy/d)*f;
      }
      for (const n of nodes) {
        n.vx += (W/2 - n.x) * 0.008; n.vy += (H/2 - n.y) * 0.008;
        n.vx *= 0.85; n.vy *= 0.85;
        if (!dragging.current || dragging.current.node !== n) { n.x += n.vx; n.y += n.vy; }
        n.x = Math.max(n.r + 10, Math.min(W - n.r - 10, n.x));
        n.y = Math.max(n.r + 10, Math.min(H - n.r - 10, n.y));
        // Repel from legend panel
        const lp = legendPosRef.current;
        const lh = legendOpenRef.current ? LEGEND_H_OPEN : LEGEND_H_CLOSED;
        const cx = Math.max(lp.x, Math.min(lp.x + LEGEND_W, n.x));
        const cy = Math.max(lp.y, Math.min(lp.y + lh, n.y));
        const ldx = n.x - cx, ldy = n.y - cy;
        const ld = Math.sqrt(ldx*ldx + ldy*ldy) || 1;
        const minD = n.r + 14;
        if (ld < minD) {
          const f = (minD - ld) * 0.5;
          n.vx += (ldx / ld) * f; n.vy += (ldy / ld) * f;
        }
      }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(pan.current.x, pan.current.y);
      ctx.scale(scaleRef.current, scaleRef.current);

      for (const e of edges) {
        const src = nodes.find(n => n.id === e.source || n.name === e.source);
        const tgt = nodes.find(n => n.id === e.target || n.name === e.target);
        if (!src || !tgt) continue;
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        ctx.strokeStyle = e.color + "55";
        ctx.lineWidth   = e.strength * 2.5;
        ctx.stroke();
      }

      for (const n of nodes) {
        const isSel = selected?.id === n.id;
        if (isSel) {
          const grd = ctx.createRadialGradient(n.x, n.y, n.r, n.x, n.y, n.r + 18);
          grd.addColorStop(0, n.color + "55"); grd.addColorStop(1, "transparent");
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 18, 0, 2*Math.PI);
          ctx.fillStyle = grd; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(n.x + 1, n.y + 2, n.r, 0, 2*Math.PI);
        ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 2*Math.PI);
        ctx.fillStyle = isSel ? n.color : n.color + "cc"; ctx.fill();
        if (isSel) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3, 0, 2*Math.PI);
          ctx.strokeStyle = "#ffffff88"; ctx.lineWidth = 2; ctx.stroke();
        }
        const fontSize = Math.max(10, Math.min(13, n.r * 1.1));
        ctx.font = `600 ${fontSize}px Inter, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        ctx.fillText(n.name, n.x, n.y + n.r + 4);
      }

      ctx.restore();
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animRef.current); window.removeEventListener("resize", resize); };
  }, [loading, selected]);

  const getNode = useCallback((sx: number, sy: number) => {
    const { x: wx, y: wy } = toWorld(sx, sy);
    return nodesRef.current.find(n => Math.sqrt((n.x-wx)**2 + (n.y-wy)**2) <= n.r + 6) || null;
  }, []);

  const getEdge = useCallback((sx: number, sy: number) => {
    const { x: wx, y: wy } = toWorld(sx, sy);
    const nodes = nodesRef.current;
    const threshold = 8 / scaleRef.current;
    for (const e of edgesRef.current) {
      const src = nodes.find(n => n.id === e.source || n.name === e.source);
      const tgt = nodes.find(n => n.id === e.target || n.name === e.target);
      if (!src || !tgt) continue;
      if (distToSegment(wx, wy, src.x, src.y, tgt.x, tgt.y) < threshold) return e;
    }
    return null;
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    mouseDown.current = { sx, sy };
    const node = getNode(sx, sy);
    if (node) {
      const { x: wx, y: wy } = toWorld(sx, sy);
      dragging.current = { node, ox: wx - node.x, oy: wy - node.y };
    } else {
      isPanning.current = true;
      panStart.current = { mx: sx, my: sy, px: pan.current.x, py: pan.current.y };
    }
  }, [getNode]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (dragging.current) {
      const { x: wx, y: wy } = toWorld(sx, sy);
      dragging.current.node.x = wx - dragging.current.ox;
      dragging.current.node.y = wy - dragging.current.oy;
      dragging.current.node.vx = 0; dragging.current.node.vy = 0;
      setHoveredEdge(null);
    } else if (isPanning.current) {
      pan.current.x = panStart.current.px + (sx - panStart.current.mx);
      pan.current.y = panStart.current.py + (sy - panStart.current.my);
      setHoveredEdge(null);
    } else {
      // Edge hover detection (only if not over a node)
      if (!getNode(sx, sy)) {
        const edge = getEdge(sx, sy);
        setHoveredEdge(edge ? { edge, sx: e.clientX, sy: e.clientY } : null);
      } else {
        setHoveredEdge(null);
      }
    }
  }, [getNode, getEdge]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    dragging.current = null;
    isPanning.current = false;
    // Treat as click only if mouse barely moved (≤5px) — works for both node clicks and canvas clicks
    const md = mouseDown.current;
    const dist = md ? Math.sqrt((sx - md.sx)**2 + (sy - md.sy)**2) : 99;
    mouseDown.current = null;
    if (dist <= 5) {
      const node = getNode(sx, sy);
      setSelected(prev => node ? (prev?.id === node.id ? null : node) : null);
    }
  }, [getNode]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.9;
    const wx = (sx - pan.current.x) / scaleRef.current;
    const wy = (sy - pan.current.y) / scaleRef.current;
    scaleRef.current = Math.max(0.2, Math.min(5, scaleRef.current * factor));
    pan.current.x = sx - wx * scaleRef.current;
    pan.current.y = sy - wy * scaleRef.current;
  }, []);

  const phases: any[] = selectedData?.phases || [];

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-[#e8e0d5] z-10 shrink-0">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href={`/story/${id}`} className="text-[#a09282] hover:text-[#1c1410] text-sm transition-colors">← Back</Link>
            <div className="w-px h-4 bg-[#e8e0d5]" />
            <span className="text-sm font-medium text-[#1c1410]">Character Relationships</span>
          </div>
          <span className="text-xs text-[#a09282]">scroll to zoom · drag to pan · click node or edge</span>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[#a09282] animate-breathe bg-[#09090b]">Building graph...</div>
        ) : (
          <canvas
            ref={canvasRef} className="w-full h-full"
            style={{ cursor: isPanning.current ? "grabbing" : "grab" }}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove}
            onMouseUp={onMouseUp} onWheel={onWheel}
          />
        )}

        {/* Draggable legend */}
        {(() => {
          const canvasH = canvasRef.current?.height ?? 600;
          const opensUp = legendPos.y > canvasH / 2;
          return (
        <div
          className="absolute text-xs select-none"
          style={{ left: legendPos.x, top: legendPos.y, zIndex: 20, width: LEGEND_W }}
        >
          {/* Header always anchored at legendPos.y */}
          <div
            className="bg-[#1a1a1f]/95 border border-white/10 rounded-2xl flex items-center justify-between px-4 py-2.5 cursor-grab active:cursor-grabbing shadow-lg backdrop-blur-sm"
            onMouseDown={(e) => {
              e.stopPropagation();
              const startX = e.clientX, startY = e.clientY;
              legendDrag.current = { ox: e.clientX - legendPos.x, oy: e.clientY - legendPos.y };
              const onMove = (ev: MouseEvent) => {
                if (!legendDrag.current) return;
                setLegendPos({ x: ev.clientX - legendDrag.current.ox, y: ev.clientY - legendDrag.current.oy });
              };
              const onUp = (ev: MouseEvent) => {
                legendDrag.current = null;
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) {
                  setLegendOpen(p => !p);
                }
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          >
            <span className="text-white/40 uppercase tracking-widest font-medium text-[10px]">Legend</span>
            <span className="text-white/25 text-[10px] ml-3">{opensUp ? (legendOpen ? "▼" : "▲") : (legendOpen ? "▲" : "▼")}</span>
          </div>

          {/* Body — below header in top half, above header in bottom half */}
          {legendOpen && (
            <div
              className="bg-[#1a1a1f]/95 border border-white/10 rounded-2xl px-4 py-3 space-y-3 shadow-lg backdrop-blur-sm"
              style={opensUp ? { position: "absolute", bottom: "100%", width: "100%", marginBottom: 4 } : { marginTop: 4 }}
            >
              <div>
                <div className="text-white/30 uppercase tracking-widest mb-2 font-medium text-[10px]">Roles</div>
                {Object.entries(ROLE_COLORS).map(([role, color]) => (
                  <div key={role} className="flex items-center gap-2 mt-1.5">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-white/60 capitalize">{role}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-white/10 pt-3">
                <div className="text-white/30 uppercase tracking-widest mb-2 font-medium text-[10px]">Relationships</div>
                {Object.entries(EDGE_COLORS).map(([type, color]) => (
                  <div key={type} className="flex items-center gap-2 mt-1.5">
                    <div className="w-5 h-0.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-white/60 capitalize">{type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        );})()}

        {/* Edge tooltip */}
        {hoveredEdge && (
          <div
            className="fixed z-50 pointer-events-none bg-[#1a1a1f]/95 border border-white/15 rounded-xl px-3 py-2 text-xs backdrop-blur-sm shadow-lg"
            style={{ left: hoveredEdge.sx + 12, top: hoveredEdge.sy - 10 }}
          >
            <span className="text-white/90 font-medium">{hoveredEdge.edge.source}</span>
            <span className="text-white/30 mx-2">—</span>
            <span className="text-white/90 font-medium">{hoveredEdge.edge.target}</span>
            <span
              className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize"
              style={{ color: hoveredEdge.edge.color, backgroundColor: hoveredEdge.edge.color + "22" }}
            >
              {hoveredEdge.edge.type}
            </span>
          </div>
        )}

        {/* Character detail panel */}
        {selected && (
          <div className="absolute top-4 right-4 w-96 bg-[#1a1a1f]/95 border border-white/10 rounded-2xl shadow-xl animate-fade-up backdrop-blur-sm flex flex-col"
               style={{ maxHeight: "calc(100% - 32px)" }}>
            {/* Header — fixed */}
            <div className="p-5 border-b border-white/10 shrink-0">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-bold text-white text-lg leading-snug">{selected.name}</h2>
                  <span className={`text-xs uppercase tracking-widest font-semibold px-2.5 py-1 rounded-full border mt-2 inline-block ${ROLE_STYLE[selected.role] || ROLE_STYLE.neutral}`}>
                    {selected.role}
                  </span>
                </div>
                <button onClick={() => setSelected(null)} className="text-white/30 hover:text-white/70 w-7 h-7 flex items-center justify-center text-xl leading-none shrink-0 mt-0.5">×</button>
              </div>
              {selected.description && (
                <p className="text-white/55 text-sm leading-relaxed mt-3">{selected.description}</p>
              )}
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 min-h-0 p-5 space-y-6">
              {!selectedData && (
                <p className="text-white/30 text-sm animate-breathe text-center py-4">Loading...</p>
              )}

              {/* Connections from graph edges */}
              {(() => {
                const conns = edgesRef.current.filter(e => e.source === selected.name || e.target === selected.name);
                if (!conns.length) return null;
                return (
                  <div>
                    <div className="text-white/30 text-xs uppercase tracking-widest mb-2 font-medium">Connections</div>
                    <div className="space-y-2">
                      {conns.map((e, i) => {
                        const other = e.source === selected.name ? e.target : e.source;
                        return (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-white/70">{other}</span>
                            <span className="px-2.5 py-0.5 rounded-full text-xs font-medium capitalize" style={{ color: e.color, backgroundColor: e.color + "22" }}>{e.type}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Fair Witness */}
              {selectedData?.fair_witness && (() => {
                const fw = selectedData.fair_witness;
                return (
                  <div className={`border rounded-xl overflow-hidden transition-colors ${showFairWitness ? "border-[#c07820]/40" : "border-white/10"}`}>
                    <button
                      onClick={() => setShowFairWitness(p => !p)}
                      className={`w-full flex items-center justify-between px-4 py-3 transition-colors text-left ${showFairWitness ? "bg-[#c07820]/15" : "bg-white/[0.04] hover:bg-white/[0.07]"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[#c07820]">✦</span>
                        <span className="text-[#c07820] text-xs font-semibold uppercase tracking-widest">Fair Witness</span>
                      </div>
                      <span className={`text-white/30 text-xs transition-transform duration-200 ${showFairWitness ? "rotate-180" : ""}`}>▼</span>
                    </button>
                    {showFairWitness && <div className="p-4 space-y-3 border-t border-[#c07820]/20 animate-fade-up">
                      {fw.fair_role && (
                        <div className="text-sm">
                          <span className="text-white/30">True role · </span>
                          <span className="text-[#c07820] font-medium">{fw.fair_role}</span>
                        </div>
                      )}
                      {fw.consensus_view && (
                        <p className="text-sm text-white/60 leading-relaxed">{fw.consensus_view}</p>
                      )}
                      {fw.hidden_motivations && (
                        <div className="text-sm">
                          <span className="text-white/30">Hidden · </span>
                          <span className="text-white/55">{fw.hidden_motivations}</span>
                        </div>
                      )}
                      {fw.narrative_bias && (
                        <p className="text-sm text-white/40 italic border-l-2 border-red-400/30 pl-3 leading-relaxed">{fw.narrative_bias}</p>
                      )}
                      {fw.what_they_would_say && (
                        <p className="text-sm text-white/50 italic bg-white/5 rounded-lg px-3 py-2.5 leading-relaxed">"{fw.what_they_would_say}"</p>
                      )}
                      {fw.fair_personality_traits?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {fw.fair_personality_traits.map((t: string) => (
                            <span key={t} className="text-xs px-2.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/45">{t}</span>
                          ))}
                        </div>
                      )}
                      {fw.disputed_aspects?.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-white/25 text-xs uppercase tracking-wider">Disputed</div>
                          {fw.disputed_aspects.map((a: any, i: number) => (
                            <div key={i} className="text-sm text-white/40 flex gap-2">
                              <span className="text-white/20 shrink-0">◦</span>
                              <span>{typeof a === "string" ? a : JSON.stringify(a)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>}
                  </div>
                );
              })()}

              {/* Character Arc with phase tabs */}
              {phases.length > 0 && (
                <div>
                  <div className="text-white/30 text-xs uppercase tracking-widest mb-2 font-medium">Character Arc</div>
                  {/* Phase tabs */}
                  <div className="flex gap-1.5 flex-wrap mb-3">
                    {phases.map((p: any, i: number) => (
                      <button
                        key={i}
                        onClick={() => setActivePhase(i)}
                        className={`text-xs px-3 py-1 rounded-lg font-medium transition-colors ${
                          i === activePhase
                            ? "bg-[#c07820] text-white"
                            : "bg-white/5 text-white/40 hover:text-white/70 border border-white/10"
                        }`}
                      >
                        {p.phase_id ? p.phase_id.replace(/_/g, " ") : `Phase ${i + 1}`}
                      </button>
                    ))}
                  </div>

                  {/* Active phase content */}
                  {(() => {
                    const phase = phases[activePhase];
                    if (!phase) return null;
                    return (
                      <div className="space-y-3 bg-white/[0.03] rounded-xl p-4 border border-white/5">
                        {phase.emotional_state && (
                          <div className="text-sm">
                            <span className="text-white/30">Feeling · </span>
                            <span className="text-white/65">{phase.emotional_state}</span>
                          </div>
                        )}
                        {phase.internal_voice && (
                          <p className="text-sm text-white/45 italic border-l-2 border-white/10 pl-3 leading-relaxed">
                            "{phase.internal_voice}"
                          </p>
                        )}
                        {phase.personality_traits?.length > 0 && (
                          <div>
                            <div className="text-white/25 text-xs uppercase tracking-wider mb-1.5">Traits</div>
                            <div className="flex flex-wrap gap-1.5">
                              {phase.personality_traits.map((t: string, ti: number) => (
                                <span key={ti} className="text-xs px-2.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/50">{t}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {phase.motivations?.length > 0 && (
                          <div>
                            <div className="text-white/25 text-xs uppercase tracking-wider mb-1.5">Motivations</div>
                            <div className="space-y-1.5">
                              {phase.motivations.map((m: any, mi: number) => (
                                <div key={mi} className="text-sm text-white/55 flex gap-2">
                                  <span className="text-[#c07820] shrink-0">›</span>
                                  <span>{typeof m === "string" ? m : JSON.stringify(m)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {phase.fears?.length > 0 && (
                          <div>
                            <div className="text-white/25 text-xs uppercase tracking-wider mb-1.5">Fears</div>
                            <div className="space-y-1.5">
                              {phase.fears.map((f: any, fi: number) => (
                                <div key={fi} className="text-sm text-white/55 flex gap-2">
                                  <span className="text-red-400/50 shrink-0">›</span>
                                  <span>{typeof f === "string" ? f : JSON.stringify(f)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {phase.knowledge_state && Object.keys(phase.knowledge_state).length > 0 && (
                          <div>
                            <div className="text-white/25 text-xs uppercase tracking-wider mb-1.5">Knowledge</div>
                            <div className="space-y-1.5">
                              {Object.entries(phase.knowledge_state).map(([key, val]) => (
                                <div key={key} className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                                  val ? "bg-emerald-900/20 border border-emerald-500/20" : "bg-white/[0.03] border border-white/5"
                                }`}>
                                  <span className={val ? "text-emerald-400" : "text-white/20"}>{val ? "✓" : "✗"}</span>
                                  <span className={val ? "text-white/65" : "text-white/30"}>{key.replace(/_/g, " ")}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {phase.relationships && Object.keys(phase.relationships).length > 0 && (
                          <div>
                            <div className="text-white/25 text-xs uppercase tracking-wider mb-1.5">Relationships</div>
                            <div className="space-y-2.5">
                              {Object.entries(phase.relationships).map(([name, rel]: [string, any]) => (
                                <div key={name} className="border-l-2 border-white/10 pl-3">
                                  <div className="flex items-center justify-between">
                                    <span className="text-white/65 font-medium text-sm">{name}</span>
                                    {rel.type && <span className="text-white/30 text-xs capitalize">{rel.type}</span>}
                                  </div>
                                  {rel.trust !== undefined && (
                                    <div className="mt-1 h-1 bg-white/5 rounded-full overflow-hidden">
                                      <div className="h-full rounded-full bg-[#c07820]/50" style={{ width: `${Math.round(rel.trust * 100)}%` }} />
                                    </div>
                                  )}
                                  {rel.description && <div className="text-white/35 text-sm mt-1 leading-relaxed">{rel.description}</div>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Key Revelations */}
              {selectedData?.knowledge_events?.length > 0 && (
                <div>
                  <div className="text-white/30 text-xs uppercase tracking-widest mb-2 font-medium">Key Revelations</div>
                  <div className="space-y-2">
                    {selectedData.knowledge_events.map((ev: any, i: number) => (
                      <div key={i} className="bg-white/[0.03] border border-white/5 rounded-xl p-3.5">
                        <div className="text-sm text-white/65 font-medium">{ev.event || (typeof ev === "string" ? ev : JSON.stringify(ev))}</div>
                        {ev.impact && <div className="text-xs text-white/35 mt-1.5 leading-relaxed">{ev.impact}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer — fixed */}
            <div className="p-4 border-t border-white/10 shrink-0">
              <Link
                href={`/story/${id}/characters/${encodeURIComponent(selected.name)}`}
                className="block text-center text-xs bg-[#c07820]/20 hover:bg-[#c07820]/30 text-[#e8960a] border border-[#c07820]/30 py-2 rounded-xl transition-colors font-medium"
              >
                Full profile →
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
