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
}

interface ExportOptions {
  graphElement?: HTMLElement | HTMLCanvasElement | null;
  turns: ExportTurn[];
  meta: ExportMeta;
  filename?: string;
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
  doc.text(opts.meta.storyTitle, margin, margin + 10);

  // Author line
  if (opts.meta.storyAuthor) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(11);
    doc.setTextColor(100, 85, 65);
    doc.text(`by ${opts.meta.storyAuthor}`, margin, margin + 30);
  }

  // Divergence block
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(100, 85, 65);
  doc.text("WHAT IF:", margin, margin + 60);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(13);
  doc.setTextColor(40, 30, 20);
  const divergenceLines = doc.splitTextToSize(opts.meta.divergence, contentW);
  doc.text(divergenceLines, margin, margin + 80);

  let y = margin + 80 + divergenceLines.length * 16 + 20;

  // Graph snapshot (if available)
  if (opts.graphElement) {
    try {
      let imgData: string | null = null;
      let imgW = 0, imgH = 0;

      if (opts.graphElement instanceof HTMLCanvasElement) {
        // Already a canvas — use directly at 2× scale for sharpness
        imgData = opts.graphElement.toDataURL("image/png");
        imgW = opts.graphElement.width;
        imgH = opts.graphElement.height;
      } else {
        // DOM element — capture via html2canvas
        const capture = await html2canvas(opts.graphElement, {
          backgroundColor: "#ffffff",
          scale: 2,
          logging: false,
          useCORS: true,
        });
        imgData = capture.toDataURL("image/png");
        imgW = capture.width;
        imgH = capture.height;
      }

      if (imgData) {
        // Fit graph into the remaining space on page 1 (with room for cast strip below)
        const maxImgH = pageH - y - margin - 120; // reserve 120pt for cast strip
        const scale = Math.min(contentW / imgW, maxImgH / imgH);
        const drawW = imgW * scale;
        const drawH = imgH * scale;
        const drawX = margin + (contentW - drawW) / 2;
        doc.addImage(imgData, "PNG", drawX, y, drawW, drawH);
        y += drawH + 20;
      }
    } catch (e) {
      console.warn("Could not capture graph for PDF export:", e);
    }
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
      const label = c.name;
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
    const bodyLines = doc.splitTextToSize(turn.message || "", contentW);
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
    const endingLines = doc.splitTextToSize(opts.meta.alternateEnding, contentW);
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
