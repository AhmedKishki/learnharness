import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MAX_IMPORT_BYTES, NotesImportErrors, NotesImportNotices, parseNotesImportResults, postNotesImport, useNotesImport, type NotesImportResult } from "../components/notes-import.tsx";

// Real hook/React state, isolated DOM and wholly stubbed import transport.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useNotesImport>;
let starts = 0;
let finishes = 0;
async function mount() {
	starts = 0;
	finishes = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	function Harness() {
		current = useNotesImport({ onStart: () => { starts++; }, onFinish: () => { finishes++; } });
		return <NotesImportErrors errors={current.errors} />;
	}
	await act(async () => { root!.render(<Harness />); });
}
async function submit(selected: File[] | null = [...files]) {
	await act(async () => { current.onImportFiles(selected as unknown as FileList | null); });
}
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
	host = undefined;
	globalThis.fetch = originalFetch;
});
const files = [new File(["one"], "same.md"), new File(["two"], "same.md")];
const completed = (requestIndex = 0): NotesImportResult => ({ requestIndex, filePath: "same.md", ok: true, outcome: "completed", stats: { nodes: 0, chains: 0 } });

it("maps out-of-order responses by index, not duplicate basenames", () => {
	const results = [completed(1), { ...completed(0), stats: { nodes: 7 } }];
	assert.deepEqual(parseNotesImportResults({ results }, files), results);
});
for (const [name, results] of [
	["missing index", [{ ...completed(), requestIndex: undefined }, completed(1)]],
	["duplicate index", [completed(), completed()]],
	["missing row", [completed()]],
	["out-of-range index", [completed(), completed(2)]],
	["wrong filename", [{ ...completed(), filePath: "different.md" }, completed(1)]],
	["missing stats", [{ ...completed(), stats: undefined }, completed(1)]],
	["unknown outcome", [{ ...completed(), outcome: "unchanged" }, completed(1)]],
	["conflicting ok", [{ ...completed(), ok: false }, completed(1)]],
	["invalid stats", [{ ...completed(), stats: { nodes: "bad" } }, completed(1)]],
	["invalid details", [{ ...completed(), slots: [42] }, completed(1)]],
	["invalid provider", [{ ...completed(), provider: 42 }, completed(1)]],
	["invalid code", [{ ...completed(), code: 42 }, completed(1)]],
	["invalid missing", [{ ...completed(), missing: [42] }, completed(1)]],
	["invalid error", [{ ...completed(), error: 42 }, completed(1)]],
	["invalid notice", [{ ...completed(), notice: 42 }, completed(1)]],
	["missing failure error", [{ ...completed(), ok: false, outcome: "failed" }, completed(1)]],
] as const) it(`malformed response (${name}) is rejected for retry`, () => {
	assert.throws(() => parseNotesImportResults({ results }, files), /Please retry/);
});

it("POST sends only captured files, and retains config/provider details", async () => {
	const refused: NotesImportResult = { requestIndex: 0, filePath: files[1]!.name, ok: false, outcome: "failed", code: "provider_key_missing", provider: "openai", slots: ["cheap"], error: "No key is set" };
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/graph/import"); assert.equal(init?.method, "POST");
		const sent = (init?.body as FormData).getAll("files") as File[];
		assert.equal(sent.length, 1); assert.equal(await sent[0]!.text(), "two");
		return Response.json({ results: [refused] });
	};
	assert.deepEqual(await postNotesImport([files[1]!]), [refused]);
});
for (const kind of ["network", "non-JSON", "non-2xx", "malformed"] as const) it(`${kind} response rejects rather than false success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: [] });
	};
	await assert.rejects(postNotesImport([files[0]!]));
});

for (const outcome of ["completed", "failed", "partial", "aborted", "busy"] as const) it(`${outcome} leaves only escaped raw failure text, without results or controls`, async () => {
	const file = new File(["notes"], "<script>notes.md");
	const result: NotesImportResult = { ...completed(), filePath: file.name, outcome, ok: outcome === "completed", error: "<img>synthetic failure", code: "provider_key_missing", provider: "openai", missing: ["OPENAI_API_KEY"], slots: ["cheap", "strong"] };
	globalThis.fetch = async () => Response.json({ results: [result] });
	await mount();
	await submit([file]);
	assert.equal(current.importing, false);
	assert.equal(starts, 1);
	assert.equal(finishes, 1);
	const html = host!.innerHTML;
	assert.doesNotMatch(html, /<button|<section|<ul|border|bg-card|rounded|shadow|Retry|Dismiss|Import complete|new propositions|Saved changes|Import stopped|already being imported/);
	assert.deepEqual(Object.keys(current).sort(), ["errors", "importing", "notices", "onImportFiles"], "no retained rows, Files, retry or dismiss API");
	if (outcome === "completed") {
		assert.equal(html, "");
		assert.deepEqual(current.errors, []);
	} else {
		assert.deepEqual(current.errors, [`${file.name}: ${result.error}\nprovider_key_missing — openai — OPENAI_API_KEY — cheap, strong`]);
		assert.match(html, /&lt;script&gt;notes.md: &lt;img&gt;synthetic failure/);
		assert.match(html, /provider_key_missing — openai — OPENAI_API_KEY — cheap, strong/);
		assert.match(html, /role="alert"/);
		assert.match(html, /text-xs text-red-400/);
		assert.match(html, /whitespace-pre-wrap break-words/);
		assert.doesNotMatch(html, /<script>|<img>/);
	}
});

for (const details of [
	{ code: "models_not_configured", missing: ["cheap", "strong", "vision"] },
	{ code: "provider_key_missing", provider: "openai", slots: ["cheap"] },
	{ code: "provider_key_missing" },
	{},
]) it(`keeps existing configuration detail strings (${JSON.stringify(details)})`, async () => {
	globalThis.fetch = async () => Response.json({ results: [{ requestIndex: 0, filePath: "same.md", ok: false, outcome: "failed", error: "Existing raw error", ...details }] });
	await mount();
	await submit([files[0]!]);
	const suffix = details.code === "models_not_configured" ? "\nmodels_not_configured — cheap, strong, vision" : details.provider ? "\nprovider_key_missing — openai — cheap" : details.code ? "\nprovider_key_missing" : "";
	assert.deepEqual(current.errors, [`same.md: Existing raw error${suffix}`]);
});

it("empty error text renders nothing; multiple errors are plain independent alerts", () => {
	assert.equal(renderToStaticMarkup(<NotesImportErrors errors={[]} />), "");
	const html = renderToStaticMarkup(<NotesImportErrors errors={["one.md: failure", "two.md: failure"]} />);
	assert.equal((html.match(/role="alert"/g) ?? []).length, 2);
	assert.doesNotMatch(html, /<section|<button|border|bg-/);
});

it("mixed out-of-order results show only failed files in selection order, including duplicate basenames", async () => {
	const selected = [new File(["success"], "success.md"), ...files];
	const results: NotesImportResult[] = [
		{ requestIndex: 2, filePath: "same.md", ok: false, outcome: "partial", error: "second duplicate" },
		{ ...completed(), filePath: "success.md" },
		{ requestIndex: 1, filePath: "same.md", ok: false, outcome: "failed", error: "first duplicate" },
	];
	globalThis.fetch = async () => Response.json({ results });
	await mount();
	await submit(selected);
	assert.deepEqual(current.errors, ["same.md: first duplicate", "same.md: second duplicate"]);
	assert.doesNotMatch(host!.innerHTML, /success.md|completed|propositions/);
});

for (const kind of ["network", "non-JSON", "non-2xx", "malformed", "duplicate index"] as const) it(`${kind} hook failure is visible for every selected file, never success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: kind === "duplicate index" ? [completed(), completed()] : [] });
	};
	await mount();
	await submit();
	const message = kind === "network" ? "synthetic offline" : kind === "non-2xx" ? "Import request failed (HTTP 503): synthetic refused. Please retry the file." : "Invalid import response. Please retry the file.";
	assert.deepEqual(current.errors, files.map((file) => `${file.name}: ${message}`));
	assert.equal(host!.querySelectorAll('[role="alert"]').length, 2);
	assert.equal(finishes, 1);
	assert.equal(current.importing, false);
});

it("actual attempts clear errors immediately, guard synchronous reentry, preserve callbacks and allow same-file reimport", async () => {
	let requests = 0;
	let resolve!: (response: Response) => void;
	globalThis.fetch = async () => { requests++; return Response.json({ results: [] }); };
	await mount();
	await submit();
	assert.equal(current.errors.length, 2);
	await submit(null);
	await submit([]);
	assert.equal(current.errors.length, 2, "cancel/empty selection is not an attempt");
	assert.equal(requests, 1);
	globalThis.fetch = async () => { requests++; return new Promise<Response>((done) => { resolve = done; }); };
	await act(async () => {
		const staleHandler = current.onImportFiles;
		staleHandler(files as unknown as FileList);
		staleHandler(files as unknown as FileList);
	});
	assert.equal(requests, 2, "ref guard rejects even same-tick reentry before React rerenders");
	assert.equal(current.importing, true);
	assert.deepEqual(current.errors, []);
	assert.equal(host!.innerHTML, "");
	assert.equal(starts, 2);
	assert.equal(finishes, 1, "finish waits for the POST");
	await submit();
	assert.equal(requests, 2, "pending attempts do not submit");
	await act(async () => { resolve(Response.json({ results: [completed(1), completed()] })); });
	assert.equal(current.importing, false);
	assert.deepEqual(current.errors, []);
	assert.equal(finishes, 2);
	globalThis.fetch = async () => { requests++; return Response.json({ results: [completed(), completed(1)] }); };
	await submit();
	assert.equal(requests, 3, "same File objects can be submitted again after settlement");
	assert.equal(starts, 3);
	assert.equal(finishes, 3);
	assert.equal(host!.innerHTML, "");
});

it("completed imports with a notice list it in selection order; failures and plain successes add none", async () => {
	const selected = [new File(["a"], "a.pdf"), new File(["b"], "b.md"), new File(["c"], "c.pdf")];
	const results: NotesImportResult[] = [
		{ requestIndex: 2, filePath: "c.pdf", ok: true, outcome: "completed", stats: { nodes: 1 }, notice: "Scanned pages may have errors." },
		{ requestIndex: 1, filePath: "b.md", ok: true, outcome: "completed", stats: { nodes: 1 } },
		{ requestIndex: 0, filePath: "a.pdf", ok: false, outcome: "failed", error: "OCR not supported yet." },
	];
	assert.deepEqual(parseNotesImportResults({ results }, selected), results);
	globalThis.fetch = async () => Response.json({ results });
	await mount();
	await submit(selected);
	assert.deepEqual(current.notices, ["c.pdf: Scanned pages may have errors."]);
	assert.deepEqual(current.errors, ["a.pdf: OCR not supported yet."]);
});

for (const [status, error] of [
	[413, "Too big. Max 25 MB."],
	[413, "Import request is too large. Select fewer files."],
	[400, "Could not read the upload. It may be incomplete; please select the files again."],
] as const) it(`server upload refusal remains readable in the client (${error})`, async () => {
	globalThis.fetch = async () => Response.json({ results: [], error }, { status });
	await mount();
	await submit();
	assert.deepEqual(current.errors, files.map((file) => `${file.name}: Import request failed (HTTP ${status}): ${error} Please retry the file.`));
	assert.deepEqual(current.notices, []);
	assert.equal(current.importing, false);
});

it("notices render as muted status lines, not alerts", () => {
	assert.equal(renderToStaticMarkup(<NotesImportNotices notices={[]} />), "");
	const html = renderToStaticMarkup(<NotesImportNotices notices={["c.pdf: Scanned pages may have errors."]} />);
	assert.match(html, /role="status"/);
	assert.match(html, /text-muted-foreground/);
	assert.doesNotMatch(html, /role="alert"|text-red/);
});

it("a pick over 25 MB in total is refused before upload, one file or several; a smaller pick still goes up", async () => {
	const half = new Uint8Array(MAX_IMPORT_BYTES / 2 + 1);
	const sent: string[][] = [];
	globalThis.fetch = async (_url, init) => {
		const form = init?.body;
		assert.ok(form instanceof FormData);
		sent.push(form.getAll("files").map((f) => (f instanceof File ? f.name : "")));
		return Response.json({ results: [{ ...completed(), filePath: "a.pdf" }] });
	};
	await mount();
	await submit([new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "textbook.pdf")]);
	await submit([new File([half], "a.pdf"), new File([half], "b.pdf")]);
	assert.deepEqual(sent, [], "nothing over the cap leaves the browser");
	assert.deepEqual(current.errors, ["a.pdf: Too big. Max 25 MB.", "b.pdf: Too big. Max 25 MB."]);
	assert.equal(starts, 0, "a refused pick starts no import");
	await submit([new File([half], "a.pdf")]);
	assert.deepEqual(sent, [["a.pdf"]]);
	assert.deepEqual(current.errors, []);
});
