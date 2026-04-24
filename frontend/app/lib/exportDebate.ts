// Shared client-side PDF exporter for WhatIfSabha debates.
// Libraries (jspdf, html2canvas) are lazy-loaded at call time so the
// initial route bundle stays small.

export interface ExportTurn {
  character: string;
  message: string;
  emotion?: string;
  phase?: string;
  round?: number;
  isOrchestrator?: boolean;
  orchestratorEvent?: string;
  target_character?: string;
  target_characters?: string[];
}

export interface ExportMeta {
  storyTitle: string;
  storyAuthor?: string;
  divergence: string;
  exportedAt?: Date;
  cast?: { name: string; color?: string; role?: string }[];
  alternateEnding?: string;
  /** Ledger snapshot from backend — adds the Ledger page to the PDF. */
  ledgerSnapshot?: {
    progress?: string;
    progress_history?: { round: number; phase: string; note: string }[];
    open_questions?: any[];
    resolved_questions?: any[];
    claims?: any[];
    positions?: Record<string, string>;
  };
  /** Per-character positions — adds the Positions page to the PDF. */
  positions?: Record<string, string>;
}

interface ExportOptions {
  graphElement?: HTMLElement | HTMLCanvasElement | SVGSVGElement | null;
  turns: ExportTurn[];
  meta: ExportMeta;
  filename?: string;
}

/**
 * Replace or strip characters that jsPDF's Helvetica can't render.
 * jsPDF ships with a Latin-1 subset; anything outside breaks text layout
 * and triggers per-character rendering (garbled output, truncated lines).
 */
function sanitizeForPdf(s: string | undefined | null): string {
  if (!s) return "";
  return s
    // Arrows → ASCII
    .replace(/→/g, "-> ")
    .replace(/←/g, "<- ")
    .replace(/↑/g, "^ ")
    .replace(/↓/g, "v ")
    // Em/en dashes → hyphens
    .replace(/[—–]/g, " -- ")
    // Smart quotes → plain
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // Ellipsis → three dots
    .replace(/\u2026/g, "...")
    // Bullet → dash
    .replace(/[•]/g, "- ")
    // Non-breaking space → regular
    .replace(/\u00A0/g, " ")
    // Strip emojis and other high-plane characters
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    // Any remaining non-Latin-1 char → space (prevents per-char render fallback)
    .replace(/[^\x00-\xFF]/g, " ")
    // Collapse repeated spaces
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Draw a simple interaction graph from turn data.
 * Returns a PNG data URL or null if no data.
 *
 * Characters are placed in a circle; edges drawn for every target-character
 * relationship, colored by frequency. No physics, no interactivity — just an
 * image suitable for embedding in a PDF.
 */
function drawSyntheticGraph(
  turns: ExportTurn[],
  cast: { name: string; color?: string }[],
): string | null {
  if (!turns.length || !cast.length) return null;

  // Compute edges: source → target counts
  const edges = new Map<string, number>();  // "source|target" → count
  for (const t of turns) {
    if (t.isOrchestrator) continue;
    const targets: string[] = [];
    if (t.target_characters?.length) targets.push(...t.target_characters);
    else if (t.target_character) targets.push(t.target_character);
    for (const target of targets) {
      if (!target || target === t.character || target === "all") continue;
      const key = `${t.character}|${target}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  // Compute node speak-counts
  const speeches = new Map<string, number>();
  for (const t of turns) {
    if (t.isOrchestrator) continue;
    speeches.set(t.character, (speeches.get(t.character) ?? 0) + 1);
  }

  // Filter cast to characters who actually appear (spoke or were targeted)
  const appeared = new Set<string>();
  for (const [key] of edges) {
    const [src, dst] = key.split("|");
    appeared.add(src);
    appeared.add(dst);
  }
  for (const [name] of speeches) appeared.add(name);

  const visibleCast = cast.filter(c => appeared.has(c.name));
  if (!visibleCast.length) return null;

  // Canvas setup — 900x600 for good resolution in PDF
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 600;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Circle layout
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(canvas.width, canvas.height) * 0.38;
  const positions = new Map<string, { x: number; y: number }>();

  visibleCast.forEach((c, i) => {
    const angle = (i / visibleCast.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(c.name, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });

  // Draw edges first (under nodes)
  const maxCount = Math.max(1, ...Array.from(edges.values()));
  for (const [key, count] of edges) {
    const [src, dst] = key.split("|");
    const p1 = positions.get(src);
    const p2 = positions.get(dst);
    if (!p1 || !p2) continue;

    const opacity = 0.25 + 0.55 * (count / maxCount);
    const isBoru = src === "Boru" || dst === "Boru";
    ctx.strokeStyle = isBoru
      ? `rgba(192, 120, 32, ${opacity + 0.1})`
      : `rgba(100, 85, 65, ${opacity})`;
    ctx.lineWidth = isBoru ? 2.0 : 1.0 + 1.5 * (count / maxCount);

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    // Arrow head at target end
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      const headSize = isBoru ? 9 : 7;
      // Offset back from the node so the arrow doesn't disappear under it
      const nodeR = 22;
      const tipX = p2.x - ux * nodeR;
      const tipY = p2.y - uy * nodeR;
      const leftX = tipX - ux * headSize + uy * headSize * 0.6;
      const leftY = tipY - uy * headSize - ux * headSize * 0.6;
      const rightX = tipX - ux * headSize - uy * headSize * 0.6;
      const rightY = tipY - uy * headSize + ux * headSize * 0.6;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(leftX, leftY);
      ctx.lineTo(rightX, rightY);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Draw nodes
  for (const c of visibleCast) {
    const p = positions.get(c.name)!;
    const speechCount = speeches.get(c.name) ?? 0;
    const r = Math.min(26, 14 + speechCount * 1.2);

    // Node circle
    ctx.fillStyle = c.color ?? "#6b5a42";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Character name label — offset outward from center
    const dirX = (p.x - cx) / radius;
    const dirY = (p.y - cy) / radius;
    const labelX = p.x + dirX * (r + 14);
    const labelY = p.y + dirY * (r + 14);
    ctx.fillStyle = "#2d241a";
    ctx.font = "600 12px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(c.name, labelX, labelY);

    // Speech count inside node
    if (speechCount > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, sans-serif";
      ctx.fillText(String(speechCount), p.x, p.y);
    }
  }

  // Title + footer
  ctx.fillStyle = "#6b5a42";
  ctx.font = "700 14px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Interaction graph", 24, 16);

  ctx.font = "11px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillStyle = "#9a8a73";
  ctx.fillText(
    `${visibleCast.length} speakers · ${edges.size} targeted interactions`,
    24, canvas.height - 22,
  );

  return canvas.toDataURL("image/png");
}

/**
 * Serialize a live SVG element to a PNG dataURL.
 *
 * This is the reliable way to capture D3 graphs — html2canvas frequently
 * fails on SVG and synthetic drawers lose the real layout. We:
 *  1. Inline the computed stroke/fill/font styles so CSS isn't lost.
 *  2. Serialize the SVG to XML, wrap in a blob URL, load via <Image>.
 *  3. Draw into a canvas and read the PNG.
 */
async function captureSvgAsPng(
  svg: SVGSVGElement,
  scale = 2,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const rect = svg.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  // Clone so we don't mutate the live DOM
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  }

  // Inline computed styles on every descendant so fonts/colors survive
  const srcDescendants = svg.querySelectorAll("*");
  const dstDescendants = clone.querySelectorAll("*");
  const STYLE_PROPS = [
    "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap",
    "opacity", "fill-opacity", "stroke-opacity",
    "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline",
  ];
  for (let i = 0; i < srcDescendants.length; i++) {
    const src = srcDescendants[i] as Element;
    const dst = dstDescendants[i] as Element;
    if (!dst) continue;
    const cs = window.getComputedStyle(src);
    for (const prop of STYLE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== "none" && v !== "0px") {
        (dst as SVGElement).style.setProperty(prop, v);
      }
    }
  }

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  } catch (e) {
    console.warn("[PDF] SVG capture failed:", e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}


export async function exportDebateToPdf(opts: ExportOptions): Promise<void> {
  // Lazy-load to keep initial bundle small — libs only pull on click
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import("jspdf"),
    import("html2canvas"),
  ]);

  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;

  // ── PAGE 1: TITLE + DIVERGENCE + GRAPH + CAST ──

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(40, 30, 20);
  doc.text(sanitizeForPdf(opts.meta.storyTitle), margin, margin + 10);

  // Author line
  if (opts.meta.storyAuthor) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(11);
    doc.setTextColor(100, 85, 65);
    doc.text(`by ${sanitizeForPdf(opts.meta.storyAuthor)}`, margin, margin + 30);
  }

  // Divergence block
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(100, 85, 65);
  doc.text("WHAT IF:", margin, margin + 60);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(13);
  doc.setTextColor(40, 30, 20);
  const divergenceLines = doc.splitTextToSize(sanitizeForPdf(opts.meta.divergence), contentW);
  doc.text(divergenceLines, margin, margin + 80);

  let y = margin + 80 + divergenceLines.length * 16 + 20;

  // Graph image — prefer the live SVG (exact reproduction) over the synthetic
  // fallback. If no graph element is provided or SVG capture fails, fall back
  // to the synthetic drawer so the PDF still has *some* graph on page 1.
  let imgData: string | null = null;
  let imgW = 0;
  let imgH = 0;

  if (opts.graphElement) {
    try {
      if (opts.graphElement instanceof SVGSVGElement) {
        const captured = await captureSvgAsPng(opts.graphElement, 2);
        if (captured) {
          imgData = captured.dataUrl;
          imgW = captured.width;
          imgH = captured.height;
          console.info(`[PDF] captured live SVG graph (${imgW}x${imgH})`);
        }
      } else if (opts.graphElement instanceof HTMLCanvasElement) {
        const canvas = opts.graphElement;
        if (canvas.width >= 10 && canvas.height >= 10) {
          imgData = canvas.toDataURL("image/png");
          imgW = canvas.width;
          imgH = canvas.height;
          console.info(`[PDF] captured live canvas graph (${imgW}x${imgH})`);
        }
      } else {
        const el = opts.graphElement as Element as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width >= 10 && rect.height >= 10) {
          const capture = await html2canvas(el, {
            backgroundColor: "#ffffff", scale: 2, logging: false, useCORS: true,
            width: rect.width, height: rect.height,
          });
          if (capture.width >= 50 && capture.height >= 50) {
            imgData = capture.toDataURL("image/png");
            imgW = capture.width;
            imgH = capture.height;
            console.info(`[PDF] captured live DOM graph (${imgW}x${imgH})`);
          }
        }
      }
    } catch (e) {
      console.warn("[PDF] live graph capture failed, will fall back to synthetic:", e);
    }
  }

  // Synthetic fallback — only runs if the live capture didn't produce an image.
  if (!imgData) {
    try {
      const synthetic = drawSyntheticGraph(opts.turns, opts.meta.cast ?? []);
      if (synthetic) {
        imgData = synthetic;
        imgW = 900;
        imgH = 600;
        console.info(`[PDF] using synthetic graph (${imgW}x${imgH})`);
      }
    } catch (e) {
      console.warn("[PDF] synthetic graph failed:", e);
    }
  }

  if (imgData && imgW > 50 && imgH > 50) {
    // Fit graph into the remaining space on page 1 (with room for cast strip below)
    const maxImgH = pageH - y - margin - 120; // reserve 120pt for cast strip
    const scale = Math.min(contentW / imgW, maxImgH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;
    const drawX = margin + (contentW - drawW) / 2;
    doc.addImage(imgData, "PNG", drawX, y, drawW, drawH);
    y += drawH + 20;
  }

  // Cast strip — render inline with colors
  if (opts.meta.cast && opts.meta.cast.length) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(100, 85, 65);
    doc.text("CAST", margin, y);
    y += 14;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const colGap = 8;
    let x = margin;
    for (const c of opts.meta.cast) {
      const label = sanitizeForPdf(c.name);
      const labelW = doc.getTextWidth(label);
      const dotSize = 8;
      const chipW = dotSize + 4 + labelW;
      if (x + chipW > pageW - margin) {
        x = margin;
        y += 16;
      }
      // Color dot
      if (c.color) {
        const { r, g, b } = hexToRgb(c.color);
        doc.setFillColor(r, g, b);
        doc.circle(x + dotSize / 2, y - 3, dotSize / 2, "F");
      }
      doc.setTextColor(40, 30, 20);
      doc.text(label, x + dotSize + 4, y);
      x += chipW + colGap;
    }
    y += 20;
  }

  // Exported-at footer on page 1
  if (opts.meta.exportedAt) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(140, 125, 110);
    doc.text(
      `Exported ${opts.meta.exportedAt.toLocaleString()} — WhatIfSabha`,
      margin, pageH - margin + 15,
    );
  }

  // ── PAGE 2+: TRANSCRIPT ──
  doc.addPage();
  let ty = margin;

  // Transcript header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(40, 30, 20);
  doc.text("Debate Transcript", margin, ty);
  ty += 20;

  for (const turn of opts.turns) {
    // Phase banner — renders once per unique phase
    // (Handled by caller passing markers if needed; we'll add simple dividers)

    // Character name line + optional emotion
    const isOrch = !!turn.isOrchestrator;
    const labelColor = isOrch ? { r: 138, g: 106, b: 31 } : { r: 40, g: 30, b: 20 };
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(labelColor.r, labelColor.g, labelColor.b);

    let nameLine = isOrch ? `Boru — ${turn.orchestratorEvent || "host"}` : turn.character;
    if (turn.target_character) nameLine += ` -> ${turn.target_character}`;
    else if (turn.target_characters?.length) nameLine += ` -> ${turn.target_characters.join(", ")}`;
    if (turn.emotion && turn.emotion !== "neutral") nameLine += `  (${turn.emotion})`;

    nameLine = sanitizeForPdf(nameLine);

    // Page-break check for name line
    if (ty > pageH - margin - 40) {
      doc.addPage();
      ty = margin;
    }
    doc.text(nameLine, margin, ty);
    ty += 14;

    // Message body
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(60, 50, 40);
    const cleanBody = sanitizeForPdf(turn.message);
    const bodyLines = doc.splitTextToSize(cleanBody, contentW);
    for (const line of bodyLines) {
      if (ty > pageH - margin) {
        doc.addPage();
        ty = margin;
      }
      doc.text(line, margin, ty);
      ty += 13;
    }
    ty += 8;
  }

  // ── LEDGER PAGE ──
  // Boru's running notes, open questions, and claims.
  const snap = opts.meta.ledgerSnapshot;
  const hasLedger = !!(snap && (
    (snap.progress && snap.progress.trim()) ||
    (snap.open_questions && snap.open_questions.length) ||
    (snap.resolved_questions && snap.resolved_questions.length) ||
    (snap.claims && snap.claims.length)
  ));
  if (hasLedger && snap) {
    doc.addPage();
    let ly = margin;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(192, 120, 32);
    doc.text("Argument Ledger", margin, ly);
    ly += 24;

    const ensureSpace = (h: number) => {
      if (ly + h > pageH - margin) { doc.addPage(); ly = margin; }
    };

    // Boru's notes — full timeline if available, otherwise just the latest.
    const notesHistory = snap.progress_history || [];
    const fallbackNote = snap.progress && snap.progress.trim()
      ? [{ round: 0, phase: "", note: snap.progress }]
      : [];
    const allNotes = notesHistory.length ? notesHistory : fallbackNote;
    if (allNotes.length) {
      ensureSpace(40);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(192, 120, 32);
      const heading = notesHistory.length > 1
        ? `Boru's Notes (${notesHistory.length})`
        : "Boru's Notes";
      doc.text(heading, margin, ly);
      ly += 14;

      for (let ni = 0; ni < allNotes.length; ni++) {
        const n = allNotes[ni];
        // Round/phase metadata
        if ((n.round && n.round > 0) || n.phase) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8);
          doc.setTextColor(160, 140, 120);
          const tag = [
            n.round && n.round > 0 ? `Round ${n.round}` : "",
            n.phase ? n.phase.replace(/_/g, " ") : "",
          ].filter(Boolean).join(" · ");
          if (tag) {
            ensureSpace(10);
            doc.text(tag, margin + 4, ly);
            ly += 11;
          }
        }
        // Note body
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10);
        doc.setTextColor(40, 30, 20);
        const noteLines = doc.splitTextToSize(sanitizeForPdf(n.note || ""), contentW - 8);
        for (const line of noteLines) {
          ensureSpace(13);
          doc.text(line, margin + 4, ly);
          ly += 13;
        }
        // Divider between notes
        if (ni < allNotes.length - 1) {
          ensureSpace(8);
          doc.setDrawColor(240, 192, 96);
          doc.setLineWidth(0.3);
          doc.line(margin + 4, ly, margin + 60, ly);
          doc.setLineWidth(1);
          ly += 8;
        }
      }
      ly += 10;
    }

    // Open questions
    if (snap.open_questions && snap.open_questions.length) {
      ensureSpace(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(180, 100, 30);
      doc.text(`Open Questions (${snap.open_questions.length})`, margin, ly);
      ly += 16;

      for (const q of snap.open_questions) {
        ensureSpace(30);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(40, 30, 20);
        const qLines = doc.splitTextToSize(sanitizeForPdf(q.question || ""), contentW - 10);
        for (const line of qLines) {
          ensureSpace(12);
          doc.text(line, margin + 6, ly);
          ly += 12;
        }
        doc.setFont("helvetica", "italic");
        doc.setFontSize(9);
        doc.setTextColor(130, 115, 100);
        const meta = `Asked by ${sanitizeForPdf(q.asked_by || "?")}${
          q.directed_to?.length ? ` -> ${sanitizeForPdf((q.directed_to as string[]).join(", "))}` : ""
        }  ·  ${q.status || "open"}`;
        ensureSpace(12);
        doc.text(meta, margin + 6, ly);
        ly += 12;

        // Answers threaded below
        if (q.answers && Object.keys(q.answers).length) {
          for (const [who, answer] of Object.entries(q.answers)) {
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9);
            doc.setTextColor(100, 85, 65);
            ensureSpace(12);
            doc.text(`${sanitizeForPdf(who)}:`, margin + 16, ly);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(60, 50, 40);
            const ansLines = doc.splitTextToSize(sanitizeForPdf(String(answer)), contentW - 30);
            const whoW = doc.getTextWidth(`${who}: `) + 2;
            let firstLineX = margin + 16 + whoW;
            let firstLineW = contentW - 30 - whoW;
            if (ansLines.length) {
              const firstFit = doc.splitTextToSize(sanitizeForPdf(String(answer)), firstLineW);
              doc.text(firstFit[0], firstLineX, ly);
              ly += 12;
              const remainder = firstFit.slice(1);
              for (const r of remainder) { ensureSpace(12); doc.text(r, margin + 30, ly); ly += 12; }
            }
          }
        }
        ly += 6;
      }
      ly += 6;
    }

    // Claims & disputes
    if (snap.claims && snap.claims.length) {
      ensureSpace(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(192, 120, 32);
      const disputed = snap.claims.filter((c: any) => c.status === "disputed").length;
      doc.text(
        `Claims & Disputes (${snap.claims.length}${disputed ? `, ${disputed} disputed` : ""})`,
        margin, ly,
      );
      ly += 16;

      for (const c of snap.claims) {
        ensureSpace(18);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(40, 30, 20);
        const char = sanitizeForPdf(c.character || "?");
        const charW = doc.getTextWidth(char + ":");
        doc.text(`${char}:`, margin + 6, ly);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 50, 40);
        const claimLines = doc.splitTextToSize(
          `"${sanitizeForPdf(c.claim || "")}"`,
          contentW - charW - 10,
        );
        if (claimLines.length) {
          doc.text(claimLines[0], margin + 6 + charW + 4, ly);
          ly += 12;
          for (let i = 1; i < claimLines.length; i++) {
            ensureSpace(12);
            doc.text(claimLines[i], margin + 12, ly);
            ly += 12;
          }
        }
        if (c.status && c.status !== "active") {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(9);
          doc.setTextColor(180, 100, 30);
          ensureSpace(12);
          doc.text(`[${c.status}]`, margin + 12, ly);
          ly += 12;
        }
        ly += 4;
      }
    }
  }

  // ── POSITIONS PAGE ──
  const positions: Record<string, string> =
    opts.meta.positions || snap?.positions || {};
  const posEntries = Object.entries(positions).filter(([, v]) => v && String(v).trim());
  if (posEntries.length) {
    doc.addPage();
    let py = margin;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(192, 120, 32);
    doc.text("Character Positions", margin, py);
    py += 24;

    const colorByName = new Map(
      (opts.meta.cast ?? []).map(c => [c.name, c.color ?? "#c07820"]),
    );

    for (const [name, pos] of posEntries) {
      if (py > pageH - margin - 30) { doc.addPage(); py = margin; }

      // Color dot + name
      const hex = colorByName.get(name) ?? "#c07820";
      const { r, g, b } = hexToRgb(hex);
      doc.setFillColor(r, g, b);
      doc.circle(margin + 4, py - 3, 4, "F");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(40, 30, 20);
      doc.text(sanitizeForPdf(name), margin + 14, py);
      py += 14;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(60, 50, 40);
      const posLines = doc.splitTextToSize(sanitizeForPdf(String(pos)), contentW - 14);
      for (const line of posLines) {
        if (py > pageH - margin) { doc.addPage(); py = margin; }
        doc.text(line, margin + 14, py);
        py += 13;
      }
      py += 8;
    }
  }

  // ── LAST: ALTERNATE ENDING ──
  if (opts.meta.alternateEnding && opts.meta.alternateEnding.trim().length) {
    doc.addPage();
    let ey = margin;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(192, 120, 32); // accent
    doc.text("Alternate Ending", margin, ey);
    ey += 24;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(40, 30, 20);
    const endingLines = doc.splitTextToSize(sanitizeForPdf(opts.meta.alternateEnding), contentW);
    for (const line of endingLines) {
      if (ey > pageH - margin) {
        doc.addPage();
        ey = margin;
      }
      doc.text(line, margin, ey);
      ey += 15;
    }
  }

  // Filename — slug from title + date
  const fileDate = (opts.meta.exportedAt ?? new Date()).toISOString().slice(0, 10);
  const slug = (opts.filename ?? opts.meta.storyTitle ?? "debate").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "debate";
  doc.save(`${slug}-debate-${fileDate}.pdf`);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
