import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * PDF → Markdown by rule, no model: pdfjs text positions and font sizes become headings,
 * paragraphs and lists. Serves the notes import (whose chunker then splits the Markdown) and
 * the pdf-reader tools. Prototyped against a 14-PDF benchmark (papers, forms, slides, scans,
 * right-to-left text); each rule below names the failure it fixes.
 */

export type PdfPage =
	| { kind: "text"; number: number; markdown: string }
	| { kind: "image-only"; number: number }
	| { kind: "empty"; number: number };

type TextContentItem = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"][number];

interface Glyph {
	str: string;
	rtl: boolean;
	x: number;
	y: number;
	size: number;
	width: number;
	rotated: boolean;
	hasEOL: boolean;
}

interface Line {
	text: string;
	rotated: boolean;
	size: number;
	y: number;
	x0: number;
}

interface PageScan {
	page: PDFPageProxy;
	height: number;
	lines: Line[];
}

type Block =
	| { type: "heading"; level: 1 | 2 | 3; text: string }
	| { type: "item"; depth: number; x0: number; y: number; size: number; text: string }
	| { type: "paragraph"; text: string };

const BULLET = /^\s*[\u2022\u25CF\u25AA\u2013\u2014\uF0B7-]\s+/;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
// Arabic presentation forms and Latin ligatures only: full-text NFKC would also flatten x² to x2.
const COMPAT = /[\uFB00-\uFB06\uFB50-\uFDFF\uFE70-\uFEFF]+/g;
const MAX_HEADING_CHARS = 150;

// Control bytes (NUL from emoji and stretchy math glyphs) carry no text; tab and newline are whitespace already.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const clean = (s: string) => s.replace(COMPAT, (m) => m.normalize("NFKC")).replace(PRIVATE_USE, "").replace(CONTROL, "");
const roundSize = (l: Line) => Math.round(l.size * 10) / 10;
// Join a wrapped line, undoing an end-of-line hyphen break ("intermedi-" + "ate").
const joinWrapped = (a: string, b: string) => (/[a-z]-$/.test(a) && /^[a-z]/.test(b) ? a.slice(0, -1) + b : `${a} ${b}`);

function toGlyph(item: TextContentItem): Glyph | null {
	if (!("str" in item)) return null;
	const [a, b, c, d, x, y] = item.transform.map(Number);
	return {
		str: item.str,
		rtl: item.dir === "rtl",
		x: x ?? 0,
		y: y ?? 0,
		size: Math.hypot(a ?? 0, b ?? 0),
		width: item.width,
		rotated: Math.abs(b ?? 0) > 0.01 || Math.abs(c ?? 0) > 0.01,
		hasEOL: item.hasEOL,
	};
}

function toLine(glyphs: Glyph[]): Line | null {
	const visible = glyphs.filter((g) => g.str.trim());
	const first = visible[0];
	if (!first) return null;
	const rtl = glyphs.filter((g) => g.str && g.rtl).length > glyphs.filter((g) => g.str).length / 2;
	// pdfjs streams right-to-left words in visual order: read them back right to left.
	const ordered = rtl ? [...glyphs].sort((p, q) => q.x - p.x) : glyphs;
	let joined = "";
	let prevEnd: number | null = null;
	for (const g of ordered) {
		// Separate boxes on a form touch in the stream with no space item: add one on a visible gap.
		if (!rtl && prevEnd !== null && g.str && !/\s$/.test(joined) && !/^\s/.test(g.str) && g.x - prevEnd > (g.size || 1) * 0.25) joined += " ";
		joined += g.str;
		if (g.str) prevEnd = g.x + g.width;
	}
	const text = clean(joined).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return {
		text,
		rotated: visible.some((g) => g.rotated),
		size: Math.max(...visible.map((g) => g.size)),
		y: first.y,
		x0: Math.min(...visible.map((g) => g.x)),
	};
}

/** Margin line numbers (bills, legal pleadings): a right-aligned column of small integers rising down
 * the page by 1 (by 2 or 3 where blank lines skip one), each written AFTER its line's words, which is
 * why it glues onto the line end ("covered1") and corrupts ranges. Numbered table rows come before their
 * labels and stay; their gap to the words is no different (both ~0.7 font sizes at the closest). Chart
 * labels rising by 10 ("20代", "30代") are not line numbers. */
function lineNumbers(glyphs: readonly Glyph[]): Set<Glyph> {
	const columns = new Map<number, Glyph[]>();
	for (const g of glyphs) {
		if (!/^\d{1,3}$/.test(g.str.trim()) || g.rotated) continue;
		const column = Math.round((g.x + g.width) / 4);
		columns.set(column, [...(columns.get(column) ?? []), g]);
	}
	const writtenAfterItsLine = (g: Glyph) =>
		glyphs.slice(0, glyphs.indexOf(g)).some((o) => o.str.trim() && o.x > g.x && Math.abs(o.y - g.y) <= g.size / 2);
	const dropped = new Set<Glyph>();
	for (const column of columns.values()) {
		const down = [...column].sort((p, q) => q.y - p.y);
		const rises = down.every((g, i) => i === 0 || [1, 2, 3].includes(Number(g.str) - Number(down[i - 1]!.str)));
		if (down.length >= 5 && rises && down.every(writtenAfterItsLine)) for (const g of column) dropped.add(g);
	}
	return dropped;
}

async function scanPage(page: PDFPageProxy): Promise<PageScan> {
	const glyphs = (await page.getTextContent()).items.flatMap((item) => toGlyph(item) ?? []);
	const margin = lineNumbers(glyphs);
	const lines: Line[] = [];
	let current: Glyph[] = [];
	const flush = () => {
		const line = toLine(current);
		if (line) lines.push(line);
		current = [];
	};
	for (const glyph of glyphs) {
		if (!margin.has(glyph)) current.push(glyph);
		if (glyph.hasEOL) flush();
	}
	flush();
	return { page, height: page.getViewport({ scale: 1 }).height, lines };
}

/** Whether a page without text draws a picture. Asked only of such pages: building the operator list
 * was two thirds of the conversion time when every page paid for it. */
async function drawsImage(page: PDFPageProxy): Promise<boolean> {
	const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	return (await page.getOperatorList()).fnArray.includes(OPS.paintImageXObject);
}

/** Running headers and footers: the same text (digits normalized) in the top or bottom 12% of at least 40% of
 * the pages. Not half: a textbook's "Access for free at openstax.org" sits on 377 of 755 pages. */
function removeChrome(pages: PageScan[]): void {
	const key = (l: Line) => l.text.replace(/\d+/g, "#");
	const seen = new Map<string, number>();
	for (const p of pages)
		for (const k of new Set(p.lines.filter((l) => l.y > p.height * 0.88 || l.y < p.height * 0.12).map(key)))
			seen.set(k, (seen.get(k) ?? 0) + 1);
	const chrome = new Set([...seen].filter(([, n]) => n >= Math.max(2, pages.length * 0.4)).map(([k]) => k));
	for (const p of pages) p.lines = p.lines.filter((l) => !chrome.has(key(l)));
}

/** Body size: the whole-point size covering the most characters. Whole points, because justified
 * text jitters between 9.8 and 10.2pt; sideways text (arXiv margin stamps) never counts. */
function bodySize(lines: readonly Line[]): number {
	const chars = new Map<number, number>();
	for (const l of lines) if (!l.rotated) chars.set(Math.round(l.size), (chars.get(Math.round(l.size)) ?? 0) + l.text.length);
	let best = 0;
	let most = -1;
	for (const [size, n] of chars) if (n > most) [best, most] = [size, n];
	return best;
}

/** Slide apps write text boxes in z-order (Keynote writes the title last), but stream order is right
 * for papers, whose columns and author grids a top-to-bottom sort scrambles. So only a title that sits
 * clearly above everything else, plus its wrapped lines, moves back to the front. */
function titleFirst(lines: Line[], body: number): Line[] {
	const [top, next] = lines.filter((l) => !l.rotated).sort((p, q) => q.y - p.y);
	if (!top || !next) return lines;
	const i = lines.indexOf(top);
	if (i <= 0 || top.size < body + 1.95 || top.y - next.y < top.size * 0.8) return lines;
	let j = i + 1;
	while (j < lines.length && Math.abs(lines[j]!.size - top.size) < 0.5 && lines[j - 1]!.y - lines[j]!.y < top.size * 1.8) j++;
	return [...lines.slice(i, j), ...lines.slice(0, i), ...lines.slice(j)];
}

function toBlocks(lines: readonly Line[], body: number, fullWidth: number): Block[] {
	// Levels by size relative to the page's body: ranking every size fails on slides, where one 72pt figure label takes level 1.
	const levelOf = (l: Line): 0 | 1 | 2 | 3 => {
		if (l.rotated || BULLET.test(l.text) || roundSize(l) < body + 1.95) return 0;
		return l.size >= body * 1.6 ? 1 : l.size >= body * 1.3 ? 2 : 3;
	};
	const blocks: Block[] = [];
	const listXs: number[] = []; // x of each open list depth
	let prev: Line | null = null;
	for (const l of lines) {
		const level = levelOf(l);
		const gap = prev !== null && prev.y - l.y > l.size * 1.8;
		const last = blocks.at(-1);
		const indent = l.size * 0.3;
		const bullet = BULLET.test(l.text);
		if (last?.type === "item" && !gap && !bullet && l.x0 > last.x0 + indent && Math.abs(l.size - last.size) < 0.5) {
			// Hanging indent: the wrapped part of a bullet starts right of its bullet glyph.
			last.text = joinWrapped(last.text, l.text);
		} else if (level) {
			if (last?.type === "heading" && last.level === level && !gap) last.text += ` ${l.text}`;
			else blocks.push({ type: "heading", level, text: l.text });
		} else if (bullet) {
			// A bullet higher up the page than the last one starts a new side-by-side list column.
			const lastItem = blocks.findLast((b) => b.type === "item");
			if (lastItem && l.y > lastItem.y + indent) listXs.length = 0;
			while (listXs.length && l.x0 < listXs.at(-1)! - indent) listXs.pop();
			if (!listXs.length || l.x0 > listXs.at(-1)! + indent) listXs.push(l.x0);
			blocks.push({ type: "item", depth: listXs.length - 1, x0: l.x0, y: l.y, size: l.size, text: l.text.replace(BULLET, "") });
		} else if (prev && (last?.type === "paragraph" || last?.type === "item") && !gap && (prev.text.length >= fullWidth || /[a-z]-$/.test(prev.text))) {
			// Wrapped prose runs near full width; table rows and form labels are short and stay apart.
			last.text = joinWrapped(last.text, l.text);
		} else {
			blocks.push({ type: "paragraph", text: l.text });
		}
		prev = l;
	}
	return blocks;
}

function toMarkdown(blocks: readonly Block[]): string {
	// Body text that starts with "#" ("# of pixels") must not read as a heading.
	const plain = (s: string) => s.replace(/^#/, "\\#");
	return blocks
		.map((b, i) => {
			switch (b.type) {
				case "heading":
					return b.text.length <= MAX_HEADING_CHARS ? `${"#".repeat(b.level)} ${b.text}` : plain(b.text);
				case "item":
					return `${"  ".repeat(b.depth)}- ${plain(b.text)}${blocks[i + 1]?.type === "item" ? "\n" : ""}`;
				case "paragraph":
					return plain(b.text);
			}
		})
		.join("\n\n")
		.replace(/\n\n\n/g, "\n");
}

/** Convert the given pages (default: all). Headers, footers and the body size are judged across the converted pages. */
export async function documentToMarkdown(doc: PDFDocumentProxy, pageNumbers?: readonly number[]): Promise<PdfPage[]> {
	const numbers = pageNumbers ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
	const pages: PageScan[] = [];
	for (const n of numbers) pages.push(await scanPage(await doc.getPage(n)));
	removeChrome(pages);
	const all = pages.flatMap((p) => p.lines);
	const docBody = bodySize(all);
	const bodyLengths = all.filter((l) => !l.rotated && Math.abs(l.size - docBody) < 0.5).map((l) => l.text.length).sort((a, b) => a - b);
	const fullWidth = (bodyLengths[Math.floor(bodyLengths.length * 0.75)] ?? 0) * 0.7;
	const out: PdfPage[] = [];
	for (const p of pages) {
		const number = p.page.pageNumber;
		if (!p.lines.length) {
			out.push({ kind: (await drawsImage(p.page)) ? "image-only" : "empty", number });
			continue;
		}
		// Each slide has its own body (bullets at 24pt, credits at 8pt); the page's largest size is its title,
		// never its body. The docBody floor keeps a paper's 8pt reference page from turning 10pt prose into headings.
		const top = Math.max(...p.lines.map(roundSize));
		const body = Math.max(docBody, bodySize(p.lines.filter((l) => roundSize(l) < top)));
		out.push({ kind: "text", number, markdown: toMarkdown(toBlocks(titleFirst(p.lines, body), body, fullWidth)) });
	}
	return out;
}

/** The pages that carry text, each under a `--- Page N ---` marker (the pdf-reader's existing format). */
export function joinPages(pages: readonly PdfPage[]): string {
	return pages.flatMap((p) => (p.kind === "text" ? [`--- Page ${p.number} ---\n\n${p.markdown}`] : [])).join("\n\n");
}
