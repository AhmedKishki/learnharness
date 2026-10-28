import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ClaudeCodeInstallationStatus, claudeCodeStatusLabel } from "../components/settings/claude-code-status.tsx";
import type { ClaudeCodeStatus } from "../src/core/contracts/claude-code.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: ClaudeCodeStatus["state"], version: string | null = null): ClaudeCodeStatus => ({ state, version, minimumVersion: "2.1.259" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="claude-code-check-again"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;
async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ClaudeCodeInstallationStatus />));
}
afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("row is informational, disclaims auth/billing readiness, and links only to official setup", () => {
	const html = renderToStaticMarkup(<ClaudeCodeInstallationStatus />);
	assert.match(html, /Authentication is not checked/);
	assert.match(html, /configuration determines billing/);
	assert.match(html, /does not guarantee MCP compatibility/);
	assert.match(html, /https:\/\/code.claude.com\/docs\/en\/setup/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert(!html.includes("Connect</button>"));
	assert(!html.includes("Sign in</button>"));
});

for (const [value, text] of [
	[status("not-found"), "Not found"],
	[status("meets-minimum", "2.1.310"), "Version 2.1.310 · meets minimum"],
	[status("update-required", "2.1.258"), "Version 2.1.258 · update required"],
	[status("version-unchecked"), "Version could not be checked"],
] as const) test(`installation display: ${text}`, () => assert.equal(claudeCodeStatusLabel(value), text));

test("mount checks once, Check again refreshes, and neither request asks for authentication", async () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url, init) => {
		calls.push(String(url));
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-claude-code"), "1");
		return Response.json(calls.length === 1 ? status("not-found") : status("meets-minimum", "2.1.310"));
	}) as typeof fetch;
	await mount();
	assert.equal(label(), "Not found");
	await act(async () => button().click());
	assert.equal(label(), "Version 2.1.310 · meets minimum");
	assert.deepEqual(calls, ["/api/claude-code", "/api/claude-code"]);
});

test("slow checks disable recheck and unmount aborts outstanding work", async () => {
	let signal: AbortSignal | null | undefined;
	let resolve!: (response: Response) => void;
	globalThis.fetch = ((_url, init) => { signal = init?.signal; return new Promise<Response>((done) => { resolve = done; }); }) as typeof fetch;
	await mount();
	assert.equal(label(), "Checking…"); assert(button().disabled);
	await act(async () => { root!.unmount(); root = undefined; });
	assert(signal?.aborted);
	await act(async () => resolve(Response.json(status("not-found"))));
	assert.equal(document.querySelector('[role="status"]'), null);
});

for (const failure of ["network", "http", "payload"] as const) test(`${failure} failure never retains a stale meets-minimum status`, async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		if (++calls === 1) return Response.json(status("meets-minimum", "2.1.310"));
		if (failure === "network") throw new Error("offline");
		return failure === "http" ? new Response(null, { status: 503 }) : Response.json({ state: "authenticated" });
	}) as typeof fetch;
	await mount(); assert.equal(label(), "Version 2.1.310 · meets minimum");
	await act(async () => button().click());
	assert.equal(label(), "Version could not be checked"); assert(!button().disabled);
});
