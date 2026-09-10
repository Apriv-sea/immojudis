type TextPdfInput = {
  title: string;
  lines: string[];
  headings?: readonly string[];
  footer?: string;
  watermark?: string | null;
};

const PAGE_LINE_LIMIT = 42;

export function createTextPdf({
  title,
  lines,
  footer,
  watermark,
  headings = [],
}: TextPdfInput): Uint8Array {
  const cleanedTitle = sanitizePdfText(title).slice(0, 120);
  const cleanedWatermark = watermark ? sanitizePdfText(watermark).slice(0, 80) : null;
  const pages = paginatePdfLines(lines, headings);
  if (pages.length === 0) pages.push([{ text: "Rapport ImmoJudis", heading: false }]);

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  const pageObjectIds: number[] = [];
  pages.forEach((pageLines, index) => {
    const pageObjectId = 5 + index * 2;
    const contentObjectId = pageObjectId + 1;
    pageObjectIds.push(pageObjectId);
    const content = pageContent({
      title: index === 0 ? cleanedTitle : `${cleanedTitle} - suite`,
      lines: pageLines,
      pageNumber: index + 1,
      pageCount: pages.length,
      footer: footer ? sanitizePdfText(footer) : null,
      watermark: cleanedWatermark,
    });
    objects[pageObjectId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objects[contentObjectId] =
      `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`;
  });

  objects[2] = `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] >>`;

  return writePdf(objects);
}

function pageContent({
  title,
  lines,
  pageNumber,
  pageCount,
  footer,
  watermark,
}: {
  title: string;
  lines: PdfLine[];
  pageNumber: number;
  pageCount: number;
  footer: string | null;
  watermark: string | null;
}): string {
  const out: string[] = [];

  if (watermark) {
    out.push("q");
    out.push("0.88 g");
    out.push("BT");
    out.push("/F1 42 Tf");
    out.push("0.707 0.707 -0.707 0.707 98 320 Tm");
    out.push(`(${escapePdfString(watermark)}) Tj`);
    out.push("ET");
    out.push("Q");
    out.push("0 g");
  }

  out.push(
    "BT",
    "/F1 16 Tf",
    "50 792 Td",
    `(${escapePdfString(title)}) Tj`,
    "/F1 10 Tf",
    "0 -28 Td",
  );

  lines.forEach((line, index) => {
    if (index > 0) out.push("0 -15 Td");
    out.push(line.heading ? "/F2 10 Tf" : "/F1 10 Tf");
    out.push(`(${escapePdfString(line.text)}) Tj`);
  });

  out.push("ET");
  out.push("BT");
  out.push("/F1 8 Tf");
  out.push("50 36 Td");
  out.push(
    `(${escapePdfString(footer ?? "ImmoJudis - rapport indicatif, à vérifier dans les pièces officielles.")}) Tj`,
  );
  out.push("420 0 Td");
  out.push(`(${pageNumber}/${pageCount}) Tj`);
  out.push("ET");

  return out.join("\n");
}

function writePdf(objects: string[]): Uint8Array {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = byteLength(pdf);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

type PdfLine = { text: string; heading: boolean };

export function paginatePdfLines(lines: string[], headings: readonly string[] = []): PdfLine[][] {
  const headingSet = new Set(headings.map(sanitizePdfText));
  const blocks = lines
    .map(sanitizePdfText)
    .filter(Boolean)
    .map((text) => ({ lines: splitLongLine(text), heading: headingSet.has(text) }));
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  const nextPage = () => {
    if (page.length) pages.push(page);
    page = [];
  };
  blocks.forEach((block, index) => {
    const following = blocks[index + 1];
    const followingSize =
      block.heading && following
        ? following.lines.length + block.lines.length <= PAGE_LINE_LIMIT
          ? following.lines.length
          : 1
        : 0;
    const gap = block.heading && page.length ? 1 : 0;
    const required =
      block.lines.length > PAGE_LINE_LIMIT && !block.heading
        ? 1
        : Math.min(PAGE_LINE_LIMIT, block.lines.length + followingSize);
    if (page.length && page.length + gap + required > PAGE_LINE_LIMIT) nextPage();
    if (block.heading && page.length) page.push({ text: "", heading: false });
    for (const text of block.lines) {
      if (page.length === PAGE_LINE_LIMIT) nextPage();
      page.push({ text, heading: block.heading });
    }
  });
  nextPage();
  return pages;
}

function splitLongLine(line: string): string[] {
  const clean = line.trim();
  if (clean.length <= 92) return [clean];
  const parts: string[] = [];
  let cursor = clean;
  while (cursor.length > 92) {
    const cut = cursor.lastIndexOf(" ", 92);
    const end = cut > 40 ? cut : 92;
    parts.push(cursor.slice(0, end).trim());
    cursor = cursor.slice(end).trim();
  }
  if (cursor) parts.push(cursor);
  return parts;
}

function sanitizePdfText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[^\x20-\x7E\u00A0-\u00FF€ŒœŸŠšŽž‘’“”–—…•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfString(value: string): string {
  return Array.from(value, (character) => {
    if (/[\\()]/.test(character)) return `\\${character}`;
    const code = WIN_ANSI_SPECIAL[character] ?? character.charCodeAt(0);
    return code > 0x7e ? `\\${code.toString(8).padStart(3, "0")}` : character;
  }).join("");
}

// Standard PDF Helvetica uses single-byte WinAnsi, not UTF-8. Octal escapes
// preserve the glyphs while keeping streams and cross-reference offsets ASCII.
const WIN_ANSI_SPECIAL: Record<string, number> = {
  "€": 0x80,
  Œ: 0x8c,
  œ: 0x9c,
  Ÿ: 0x9f,
  Š: 0x8a,
  š: 0x9a,
  Ž: 0x8e,
  ž: 0x9e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "–": 0x96,
  "—": 0x97,
  "…": 0x85,
  "•": 0x95,
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
