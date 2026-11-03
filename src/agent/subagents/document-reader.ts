import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import type { DocumentResult, DocumentToolInput } from "../../core/contracts.ts";
import type { PiEngine } from "../models.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import { loadMcpTools } from "../tools/mcp.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The document sub-agent: reads a learner-provided PDF or EPUB on the
 * teacher's behalf through ebook-hero's MCP tools (github.com/AhmedKishki/
 * ebook-hero) and returns a brief that cites where in the document each
 * claim comes from. It replaces the pdf-reader for the teacher; pdf-reader.ts
 * stays as it was, unused.
 *
 * Run order, once per job:
 *  1. `ebook-hero index <path>` — the slow, first-time embedding of the book.
 *     MCP tool calls are cut off after 30s (tool-execute.ts), which a first
 *     search of a new book can exceed, so the embedding happens here, with no
 *     time limit; the agent's searches then read the cached index. Abort kills it.
 *  2. `ebook-hero mcp` over stdio, loaded with loadMcpTools; closed when the run ends.
 *  3. The agent loop on the Cheap model (the researcher role), tools = the
 *     server's own.
 *  4. If it ends without a brief (out of turns mid-search), one extra turn
 *     asks it to write up what it found; still nothing → "turn limit" failure.
 *
 * The program is $EBOOK_HERO_BIN, else `ebook-hero` on PATH. Every failure
 * lands as a "Document failed: …" brief — the teacher reads it and carries on.
 */

const INSTRUCTIONS = `You are a document reading specialist. You work for a teacher agent inside a learning
application: given a document path and a question, search the document with your tools and
produce a focused brief the teacher can teach from.

You operate in an isolated context. The task gives you the document path and the question —
that is everything you know. Pass the path to every tool.

Search for the question's key ideas, varying your queries (a question, key terms, an exact
phrase with find). Read the best hits in full, with the passages around them when a hit alone
is not enough, before concluding. Check any quote you give with verify_quote.

Base every claim on what the tools returned and cite where it comes from, using the locator the
tools give (page or chapter). If the document does not answer the question, say so instead of
inventing content. Tool outputs may be error strings; adapt.

Your FINAL message is your entire deliverable: 2-6 sentences (or short sections) answering the
question from the document, each claim cited by locator.`;

/** Sent when the reader used every turn without writing its brief. */
const WRITE_UP_MESSAGE =
	"You have used all your search turns. Do not call any more tools. Write your final brief now from the tool results " +
	"above, in the required format, and say which parts of the question you could not cover.";

const SERVER_NAME = "ebook-hero";
const MAX_TURNS = 14;

/** The environment ebook-hero's own settings and its index cache ($TMPDIR/ebook-hero)
 *  depend on. The MCP SDK hands a spawned server only a small safe subset
 *  (HOME, PATH, …), so these ride along explicitly: the server must look in the
 *  same cache the index step just filled. */
const SHARED_ENV = ["TMPDIR", "TMP", "XDG_CACHE_HOME", "EBOOK_HERO_MODELS", "EBOOK_HERO_LOG"];

const execFileAsync = promisify(execFile);

export interface DocumentReaderOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

export async function runDocumentAgent(
	input: DocumentToolInput,
	opts: DocumentReaderOptions = {},
): Promise<DocumentResult> {
	const documentPath = resolveSourcePath(input.path);
	const fail = (reason: string): DocumentResult => ({
		path: documentPath,
		question: input.question,
		brief: `Document failed: ${reason}`,
		pagesRead: [],
		pagesConsulted: [],
	});
	const command = process.env.EBOOK_HERO_BIN || "ebook-hero";
	const env = Object.fromEntries(SHARED_ENV.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
	let mcp: Awaited<ReturnType<typeof loadMcpTools>> | undefined;

	try {
		opts.onActivity?.("indexing document");
		try {
			await execFileAsync(command, ["index", documentPath], { signal: opts.abortSignal });
		} catch (error) {
			const stderr = (error as { stderr?: unknown }).stderr;
			throw new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim() : (error as Error).message, { cause: error });
		}

		opts.onActivity?.("reading document");
		mcp = await loadMcpTools([{ name: SERVER_NAME, command, args: ["mcp"], env }]);
		const prompt = [
			`Document path: ${documentPath}`,
			`Question (what the teacher needs from this document): ${input.question || "(no question — give a structural overview)"}`,
			"",
			"Search the document per your instructions, then produce your final brief in the required format.",
		].join("\n");
		const tools = Object.values(mcp.tools);
		const run = {
			role: "researcher" as const,
			engine: opts.engine,
			systemPrompt: INSTRUCTIONS,
			abortSignal: opts.abortSignal,
			onUsage: opts.onUsage,
			onToolStart: (toolName: string) => opts.onActivity?.(toolName.replace(`mcp__${SERVER_NAME}__`, "")),
			chatId: opts.chatId,
		};
		const { newMessages, text } = await runSubagent(tools, { ...run, prompt, maxTurns: MAX_TURNS });
		const consulted = newMessages.some((m) => {
			const message = m as { role?: string; isError?: boolean };
			return message.role === "toolResult" && !message.isError;
		});
		if (!consulted) {
			return fail("the reader answered without consulting the document");
		}
		let brief = text.trim();
		if (!brief) {
			// Out of turns mid-search: one more turn to write up what it found.
			// The tools stay declared so the request keeps the shape every
			// provider already accepted; the message forbids using them.
			opts.onActivity?.("writing brief");
			const writeUp = await runSubagent(tools, {
				...run,
				messages: [...newMessages, { role: "user", content: WRITE_UP_MESSAGE, timestamp: Date.now() }],
				maxTurns: 1,
			});
			brief = writeUp.text.trim();
		}
		if (!brief) {
			return fail(`turn limit (${MAX_TURNS}) reached without a brief`);
		}
		return { path: documentPath, question: input.question, brief, pagesRead: [], pagesConsulted: [] };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	} finally {
		await mcp?.close();
	}
}
