#!/usr/bin/env node
/**
 * Stand-in `ebook-hero` program for tests (src/agent/subagents/document-reader.ts).
 *   fake-ebook-hero index <path>  logs the call, then exits (the slow embedding step)
 *   fake-ebook-hero mcp           logs the call, then serves fake-mcp-server.mjs over stdio
 * Every call appends {command, args, pid, tmpdir} to $HOME/fake-ebook-hero.log; HOME
 * is what the MCP SDK hands a spawned server, so the log is reachable from both modes.
 * tmpdir is the TMPDIR the call saw: ebook-hero caches its index under it.
 * FAKE_INDEX_FAIL=<text>    `index` prints the text to stderr and exits 1.
 * FAKE_INDEX_SLEEP_MS=<ms>  `index` waits that long before exiting.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const entry = { command, args, pid: process.pid, tmpdir: process.env.TMPDIR ?? null };
appendFileSync(join(homedir(), "fake-ebook-hero.log"), `${JSON.stringify(entry)}\n`);

if (command === "index") {
	if (process.env.FAKE_INDEX_FAIL) {
		console.error(process.env.FAKE_INDEX_FAIL);
		process.exit(1);
	}
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_INDEX_SLEEP_MS) || 0));
} else if (command === "mcp") {
	await import("./fake-mcp-server.mjs");
} else {
	console.error(`unknown command: ${command}`);
	process.exit(2);
}
