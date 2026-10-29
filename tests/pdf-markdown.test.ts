/**
 * pdf-markdown — the rule-based PDF → Markdown converter, against hand-built PDFs whose layout each
 * test spells out (tests/helpers/tiny-pdf.ts) plus the committed 3-page fixture.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { documentToMarkdown, joinPages, type PdfPage } from "../src/agent/subagents/pdf-markdown.ts";
import { tinyPdf, type Run, type TinyPage } from "./helpers/tiny-pdf.ts";

async function convert(data: Uint8Array, pageNumbers?: number[]): Promise<PdfPage[]> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = pdfjs.getDocument({ data, verbosity: 0 });
	try {
		return await documentToMarkdown(await task.promise, pageNumbers);
	} finally {
		await task.destroy();
	}
}

function markdownOf(page: PdfPage | undefined): string {
	assert.ok(page?.kind === "text", `expected a page with text, got ${page?.kind}`);
	return page.markdown;
}

/** Lines stacked down the page at a fixed step, like typeset text. */
function stack(texts: string[], opts: { x?: number; y: number; size?: number; step?: number }): Run[] {
	return texts.map((text, i) => ({ text, x: opts.x ?? 72, y: opts.y - i * (opts.step ?? 12), size: opts.size ?? 10 }));
}

const LONG_A = "The light reactions capture energy from sunlight and store it in carriers for later intermedi-";
const LONG_B = "ate steps, which the Calvin cycle then spends to fix carbon dioxide into sugars inside the cell";

describe("pdf-markdown — structure", () => {
	it("turns larger text into headings and joins wrapped prose, undoing hyphen breaks", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				{ text: "Photosynthesis", x: 72, y: 720, size: 20 },
				...stack([LONG_A, LONG_B, "and starch for storage."], { y: 690 }),
			],
		}]));
		assert.equal(markdownOf(page), `# Photosynthesis\n\n${LONG_A.slice(0, -1)}${LONG_B} and starch for storage.`);
	});

	it("joins a link broken after its slash without a space", async () => {
		const [page] = await convert(tinyPdf([{ runs: stack(["Fill in the short survey before the end of the week at https://forms.gle/", "zEwAbgswCVXtTnrB8 to help us."], { y: 700 }) }]));
		assert.match(markdownOf(page), /https:\/\/forms\.gle\/zEwAbgswCVXtTnrB8 to help us\./);
	});

	it("keeps a compound's own hyphen at a line break when the document writes it hyphenated elsewhere", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				...stack(["Clinics often use cognitive-behavioral therapy for anxiety and for related disorders today.", "Many patients first try a short course of guided cognitive-", "behavioral therapy with a trained counselor."], { y: 700 }),
			],
		}]));
		assert.match(markdownOf(page), /guided cognitive-behavioral therapy/);
		assert.doesNotMatch(markdownOf(page), /cognitivebehavioral/);
	});

	it("keeps short rows apart: table rows and form labels are not wrapped prose", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				...stack([LONG_A, LONG_B, "end."], { y: 720 }),
				...stack(["Enzyme Km Vmax", "Lactase 2.4 9.1", "Catalase 25 40"], { y: 640 }),
			],
		}]));
		const md = markdownOf(page);
		assert.match(md, /\n\nEnzyme Km Vmax\n\nLactase 2\.4 9\.1\n\nCatalase 25 40$/);
	});

	it("drops a running footer repeated on every page, page numbers included", async () => {
		const pages: TinyPage[] = ["Cells", "Tissues", "Organs"].map((topic, i) => ({
			runs: [{ text: `${topic} are covered here.`, x: 72, y: 600 }, { text: `Biology 101 - page ${i + 1}`, x: 72, y: 30, size: 8 }],
		}));
		const out = await convert(tinyPdf(pages));
		assert.deepEqual(out.map(markdownOf), ["Cells are covered here.", "Tissues are covered here.", "Organs are covered here."]);
	});

	it("rejoins a hyphen break after an accented letter (French)", async () => {
		const [page] = await convert(tinyPdf([{ runs: stack(["Le commissaire peut examiner selon la pré-", "sente partie."], { y: 700 }) }]));
		assert.equal(markdownOf(page), "Le commissaire peut examiner selon la présente partie.");
	});

	it("never takes a heading from large digits or symbols (chart labels, map zones)", async () => {
		const [page] = await convert(tinyPdf([{ runs: [{ text: "2 2/3 43 5", x: 72, y: 720, size: 24 }, ...stack(["Body text about the zones.", "More body text."], { y: 680 })] }]));
		assert.ok(!markdownOf(page).includes("#"), markdownOf(page));
	});

	it("never takes a heading from sideways text, however large", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [{ text: "arXiv:1706.03762v7", x: 30, y: 300, size: 20, rotated: true }, ...stack(["Body line one", "Body line two"], { y: 700 })],
		}]));
		assert.ok(!markdownOf(page).includes("#"), markdownOf(page));
	});

	it("escapes body text that starts with # so it cannot read as a heading", async () => {
		const [page] = await convert(tinyPdf([{ runs: [{ text: "# of pixels used", x: 72, y: 700 }] }]));
		assert.equal(markdownOf(page), "\\# of pixels used");
	});

	it("drops margin line numbers written after their lines, but keeps numbered rows written before their labels", async () => {
		const bill = ["covered platform means", "a social media service", "ages 0 to 5, 6 to 9", "or an online platform", "that connects to the internet"];
		const [billPage, tablePage] = await convert(tinyPdf([
			{ runs: bill.flatMap((text, i) => [{ text, x: 150, y: 700 - i * 30 }, { text: String(i + 1), x: 100, y: 700 - i * 30 }]) },
			{ runs: ["Bank credit", "Securities", "Loans", "Real estate", "Deposits"].flatMap((label, i) => [{ text: String(i + 1), x: 72, y: 700 - i * 30 }, { text: label, x: 86, y: 700 - i * 30 }]) },
		]));
		assert.equal(markdownOf(billPage), bill.join("\n\n"));
		assert.match(markdownOf(tablePage), /^1 Bank credit\n\n2 Securities\n\n3 Loans/);
	});

	it("keeps chart labels whose numbers rise by 10, even when written after their unit", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [20, 30, 40, 50, 60].flatMap((age, i) => [{ text: "s", x: 120, y: 700 - i * 30 }, { text: String(age), x: 100, y: 700 - i * 30 }]),
		}]));
		assert.match(markdownOf(page), /20/);
		assert.match(markdownOf(page), /60/);
	});

	it("drops a footer that repeats on 40% of the pages", async () => {
		const out = await convert(tinyPdf(["One", "Two", "Three", "Four", "Five"].map((word, i) => ({
			runs: [{ text: `Page ${word} text.`, x: 72, y: 600 }, ...(i < 2 ? [{ text: "Access for free at openstax.org", x: 72, y: 30, size: 8 }] : [])],
		}))));
		assert.deepEqual(out.map(markdownOf), ["Page One text.", "Page Two text.", "Page Three text.", "Page Four text.", "Page Five text."]);
	});

	it("strips control characters that some fonts emit for math glyphs", async () => {
		const [page] = await convert(tinyPdf([{ runs: [{ text: "x ~ y", x: 72, y: 700 }] }]));
		assert.equal(markdownOf(page), "x y");
	});
});

describe("pdf-markdown — slides", () => {
	it("moves a title written last in the file back to the top (Keynote's z-order)", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				{ text: "• First point", x: 72, y: 600, size: 24 },
				{ text: "• Second point", x: 72, y: 560, size: 24 },
				{ text: "References", x: 200, y: 720, size: 44 },
			],
		}]));
		assert.equal(markdownOf(page), "# References\n\n- First point\n- Second point");
	});

	it("nests sub-bullets and joins a bullet's wrapped second line", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				{ text: "Grading policy", x: 200, y: 720, size: 44 },
				{ text: "• Final project: 40%", x: 72, y: 640, size: 28 },
				{ text: "– Milestone: 5%", x: 110, y: 600, size: 24 },
				{ text: "– Read the code book, understand what is", x: 110, y: 565, size: 24 },
				{ text: "academic infraction", x: 128, y: 537, size: 24 },
				{ text: "• Late policy", x: 72, y: 495, size: 28 },
			],
		}]));
		assert.equal(
			markdownOf(page),
			"# Grading policy\n\n- Final project: 40%\n  - Milestone: 5%\n  - Read the code book, understand what is academic infraction\n- Late policy",
		);
	});

	it("starts each side-by-side bullet column at the top level", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				{ text: "• Animals", x: 20, y: 400, size: 22 },
				{ text: "• Bird", x: 60, y: 372, size: 22 },
				{ text: "• Plants", x: 250, y: 400, size: 22 },
				{ text: "• Tree", x: 290, y: 372, size: 22 },
			],
		}]));
		assert.equal(markdownOf(page), "- Animals\n  - Bird\n- Plants\n  - Tree");
	});
});

describe("pdf-markdown — reading order", () => {
	it("keeps a two-column page in stream order: the left column, then the right", async () => {
		const [page] = await convert(tinyPdf([{
			runs: [
				...stack(["Left column first line", "Left column second line"], { x: 72, y: 700 }),
				...stack(["Right column first line", "Right column second line"], { x: 320, y: 704 }),
			],
		}]));
		const md = markdownOf(page);
		assert.ok(md.indexOf("Left column second line") < md.indexOf("Right column first line"), md);
	});

	/** One page row per baseline, the way the datasheet cover writes its two columns. */
	const sideBySide = (left: string[], right: string[], rightX = 320) =>
		left.flatMap((text, i) => [{ text, x: 72, y: 700 - i * 14 }, { text: right[i]!, x: rightX, y: 700 - i * 14 }]);

	it("splits two prose columns that share baselines and reads the left column first", async () => {
		const left = ["the timer is a stable device", "for generating accurate delays", "or oscillation with two parts", "an external resistor sets it", "and a capacitor holds charge"];
		const right = ["direct replacement for older", "timing from microseconds on", "operates in two common modes", "output can sink or source", "stability is better than most"];
		const [page] = await convert(tinyPdf([{ runs: sideBySide(left, right) }]));
		const md = markdownOf(page);
		assert.ok(left.every((line) => md.includes(line)) && right.every((line) => md.includes(line)), md);
		assert.ok(md.indexOf(left.at(-1)!) < md.indexOf(right[0]!), `left column first:\n${md}`);
	});

	it("keeps table rows whole: code cells are not prose, and a 3-column table's halves hold cell gaps", async () => {
		const codes = await convert(tinyPdf([{ runs: sideBySide(["GPIO0 HIGH SDA0 SA5", "GPIO1 HIGH SCL0 SA4", "GPIO2 HIGH SDA1 SA3", "GPIO3 HIGH SCL1 SA2", "GPIO4 HIGH GPCLK0 SA1"], ["PCLK SPI3 CE0 TXD2", "DE SPI3 MISO RXD2", "LCD SPI3 MOSI CTS2", "LCD SPI3 SCLK RTS2", "DPI SPI4 CE0 TXD3"]) }]));
		assert.match(markdownOf(codes[0]), /GPIO0 HIGH SDA0 SA5 PCLK SPI3 CE0 TXD2/);
		const rows = [["Acetylcholine", "muscle action and memory", "increased arousal and cognition"], ["Endorphin", "pain and pleasure felt", "decreased anxiety and tension"], ["Dopamine", "mood and sleep patterns", "increased mood and less sleep"], ["Serotonin", "mood and appetite levels", "modulated mood and appetite"], ["Glutamate", "learning and memory traces", "increased learning and memory"]];
		const [table] = await convert(tinyPdf([{ runs: rows.flatMap((cells, i) => cells.map((text, c) => ({ text, x: 72 + c * 160, y: 700 - i * 14 }))) }]));
		assert.match(markdownOf(table), /Acetylcholine muscle action and memory increased arousal and cognition/);
	});

	it("adds the missing space when a line's text jumps back left", async () => {
		const [page] = await convert(tinyPdf([{ runs: [{ text: "Return", x: 300, y: 700 }, { text: "Form 1040", x: 72, y: 700 }] }]));
		assert.equal(markdownOf(page), "Return Form 1040");
	});
});

describe("pdf-markdown — page kinds", () => {
	it("tells text, picture-only and blank pages apart; a scan's hidden text layer reads as text", async () => {
		const out = await convert(tinyPdf([
			{ runs: [{ text: "Typed page", x: 72, y: 700 }] },
			{ image: true, runs: [{ text: "Scanned words", x: 72, y: 700, invisible: true }] },
			{ image: true },
			{},
		]));
		assert.deepEqual(out.map((p) => p.kind), ["text", "text", "image-only", "empty"]);
		assert.equal(markdownOf(out[1]), "Scanned words");
	});

	it("joinPages marks only pages with text, numbered as in the file", async () => {
		const out = await convert(tinyPdf([{ image: true }, { runs: [{ text: "Second", x: 72, y: 700 }] }, {}, { runs: [{ text: "Fourth", x: 72, y: 700 }] }]));
		assert.equal(joinPages(out), "--- Page 2 ---\n\nSecond\n\n--- Page 4 ---\n\nFourth");
	});

	it("converts only the requested pages", async () => {
		const out = await convert(tinyPdf([1, 2, 3].map((n) => ({ runs: [{ text: `Page ${n} text`, x: 72, y: 700 }] }))), [1, 3]);
		assert.deepEqual(out.map((p) => p.number), [1, 3]);
	});

	it("separates words in the committed fixture instead of gluing them", async () => {
		const data = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf")));
		const md = joinPages(await convert(data));
		assert.match(md, /^--- Page 1 ---/);
		assert.match(md, /Calculus/);
		assert.ok(!/[a-z][A-Z][a-z]/.test(md.replace(/[A-Z]{2,}/g, "")), `no camel-glued words: ${md.slice(0, 200)}`);
	});
});
