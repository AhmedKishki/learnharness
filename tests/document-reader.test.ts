/**
 * The document sub-agent (src/agent/subagents/document-reader.ts): the PDF
 * reader's replacement, driven by ebook-hero's MCP tools.
 *
 * Every test runs the real path (the `index` command, the stdio MCP
 * connection, the agent loop on a faux model) against a stand-in program
 * (tests/fixtures/mcp/fake-ebook-hero.mjs) that logs each call to
 * $HOME/fake-ebook-hero.log. The fake serves the MCP fixture's `echo` tool, so
 * the wiring is what's under test, not ebook-hero's own tools.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { runDocumentAgent } from "../src/agent/subagents/document-reader.ts";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/mcp/fake-ebook-hero.mjs", import.meta.url));
const ECHO = "mcp__ebook-hero__echo";
const RELATIVE_BOOK = path.join("Books", "alice.epub");

type LogEntry = { command: string; args: string[]; pid: number; tmpdir: string | null };

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A model that consults the document once, then briefs. */
function consultingEngine(brief: string): PiEngine {
	return fauxEngine([
		fauxAssistantMessage([fauxToolCall(ECHO, { text: "queen of hearts" }, { id: "t1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText(brief)]),
	]);
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

describe("document reader (ebook-hero over MCP)", () => {
	let home: string;
	let book: string;
	const saved: Record<string, string | undefined> = {};
	const ENV_KEYS = ["HOME", "USERPROFILE", "PATH", "TMPDIR", "EBOOK_HERO_BIN", "FAKE_INDEX_FAIL", "FAKE_INDEX_SLEEP_MS"];

	beforeEach(() => {
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-document-home-"));
		book = path.join(home, RELATIVE_BOOK);
		fs.mkdirSync(path.dirname(book), { recursive: true });
		fs.writeFileSync(book, "not a real book: the fake never opens it");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.EBOOK_HERO_BIN = FAKE_BIN;
		delete process.env.FAKE_INDEX_FAIL;
		delete process.env.FAKE_INDEX_SLEEP_MS;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(home, { recursive: true, force: true });
	});

	function log(): LogEntry[] {
		try {
			return fs
				.readFileSync(path.join(home, "fake-ebook-hero.log"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as LogEntry);
		} catch {
			return [];
		}
	}

	it("the brief is the agent's final text, written after the document's tool results reached it", async () => {
		const engine = consultingEngine("The Queen orders beheadings (ch. 8).");
		let lastContext = "";
		const stream = engine.streamFn;
		engine.streamFn = (...args) => {
			lastContext = JSON.stringify(args[1]);
			return stream(...args);
		};

		const result = await runDocumentAgent({ path: RELATIVE_BOOK, question: "What does the Queen want?" }, { engine });

		assert.equal(result.brief, "The Queen orders beheadings (ch. 8).");
		assert.equal(result.question, "What does the Queen want?");
		assert.match(lastContext, /echo: queen of hearts/, "the MCP tool's result entered the model's context");
	});

	it("indexes the resolved absolute path once, before the server starts", async () => {
		const result = await runDocumentAgent(
			{ path: RELATIVE_BOOK, question: "anything" },
			{ engine: consultingEngine("Done (ch. 1).") },
		);

		assert.equal(result.path, book, "a home-relative path comes back absolute");
		assert.deepEqual(
			log().map(({ command, args }) => ({ command, args })),
			[
				{ command: "index", args: [book] },
				{ command: "mcp", args: [] },
			],
		);
	});

	it("the server sees the same TMPDIR as the index step, so it finds the index just built", async () => {
		const cacheRoot = path.join(home, "cache-root");
		process.env.TMPDIR = cacheRoot;

		await runDocumentAgent({ path: RELATIVE_BOOK, question: "anything" }, { engine: consultingEngine("Done (ch. 1).") });

		assert.deepEqual(
			log().map((entry) => [entry.command, entry.tmpdir]),
			[
				["index", cacheRoot],
				["mcp", cacheRoot],
			],
		);
	});

	it("shuts the server down when the run ends", async () => {
		await runDocumentAgent({ path: RELATIVE_BOOK, question: "anything" }, { engine: consultingEngine("Done (ch. 1).") });

		const server = log().find((entry) => entry.command === "mcp");
		assert.ok(server, "the server was started");
		assert.equal(isRunning(server.pid), false);
	});

	it("an index failure becomes a Document failed brief, with no server and no model call", async () => {
		process.env.FAKE_INDEX_FAIL = "models could not be downloaded";
		let modelCalls = 0;
		const engine = fauxEngine([]);
		engine.streamFn = () => {
			modelCalls++;
			throw new Error("the model must not be called");
		};

		const result = await runDocumentAgent({ path: RELATIVE_BOOK, question: "anything" }, { engine });

		assert.match(result.brief, /^Document failed:.*models could not be downloaded/s);
		assert.equal(modelCalls, 0);
		assert.deepEqual(log().map((entry) => entry.command), ["index"], "the server never started");
	});

	it("a missing program becomes a Document failed brief that names it", async () => {
		const missing = path.join(home, "no-such-ebook-hero");
		process.env.EBOOK_HERO_BIN = missing;

		const result = await runDocumentAgent(
			{ path: RELATIVE_BOOK, question: "anything" },
			{ engine: consultingEngine("never reached") },
		);

		assert.match(result.brief, /^Document failed:/);
		assert.ok(result.brief.includes(missing), `the brief names the program: ${result.brief}`);
		assert.deepEqual(log(), []);
	});

	it("without EBOOK_HERO_BIN it runs ebook-hero from PATH", async () => {
		const bin = path.join(home, "bin");
		fs.mkdirSync(bin);
		fs.symlinkSync(FAKE_BIN, path.join(bin, "ebook-hero"));
		delete process.env.EBOOK_HERO_BIN;
		process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;

		const result = await runDocumentAgent(
			{ path: RELATIVE_BOOK, question: "anything" },
			{ engine: consultingEngine("Found via PATH (ch. 1).") },
		);

		assert.equal(result.brief, "Found via PATH (ch. 1).");
		assert.deepEqual(log().map((entry) => entry.command), ["index", "mcp"]);
	});

	it("an agent that answers without consulting the document delivers no brief", async () => {
		const result = await runDocumentAgent(
			{ path: RELATIVE_BOOK, question: "anything" },
			{ engine: fauxEngine([fauxAssistantMessage([fauxText("The answer is 42, trust me.")])]) },
		);

		assert.match(result.brief, /^Document failed:.*without consulting/);
		assert.doesNotMatch(result.brief, /42/);
		const server = log().find((entry) => entry.command === "mcp");
		assert.ok(server && !isRunning(server.pid), "the server is still shut down");
	});

	it("an agent whose every tool call failed delivers no brief", async () => {
		const result = await runDocumentAgent(
			{ path: RELATIVE_BOOK, question: "anything" },
			{
				engine: fauxEngine([
					fauxAssistantMessage([fauxToolCall("mcp__ebook-hero__fail", {}, { id: "t1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage([fauxText("The answer is 42, trust me.")]),
				]),
			},
		);

		assert.match(result.brief, /^Document failed:.*without consulting/);
		assert.doesNotMatch(result.brief, /42/);
	});

	it("aborting during the index step kills the index and starts no server", async () => {
		process.env.FAKE_INDEX_SLEEP_MS = "30000";
		const controller = new AbortController();
		const started = Date.now();
		const run = runDocumentAgent(
			{ path: RELATIVE_BOOK, question: "anything" },
			{ engine: consultingEngine("never reached"), abortSignal: controller.signal },
		);
		while (log().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();

		const result = await run;

		assert.match(result.brief, /^Document failed:/);
		assert.ok(Date.now() - started < 10_000, "the 30s index was cut short");
		const index = log().find((entry) => entry.command === "index");
		assert.ok(index);
		// The run settles as soon as the abort lands; the kill signal then takes a moment.
		for (let waited = 0; isRunning(index.pid) && waited < 2_000; waited += 20) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(isRunning(index.pid), false, "the index process was killed");
		assert.deepEqual(log().map((entry) => entry.command), ["index"]);
	});
});
