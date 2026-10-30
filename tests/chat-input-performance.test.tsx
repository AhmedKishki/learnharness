import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { ChatSessionComposer } from "../components/composer.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { readPathInput } from "../components/path-input-dom.ts";

const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
let active: Element = document.body;
Object.defineProperty(document, "activeElement", { get: () => active });
const selection = {
	anchorNode: null as Node | null,
	anchorOffset: 0,
	focusNode: null as Node | null,
	focusOffset: 0,
	setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
		Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
	},
};
Object.assign(document, { getSelection: () => selection, oninput: null });
window.HTMLElement.prototype.focus = function () { active = this; };
Object.assign(globalThis, {
	window,
	document,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
});

const roots: { root: Root; host: HTMLElement }[] = [];

async function mount(element: React.ReactElement) {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

async function typeText(editor: HTMLElement, value: string) {
	await act(async () => {
		editor.replaceChildren(document.createTextNode(value));
		editor.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
});

describe("session text fields keep keystrokes local", () => {
	it("updates composer and send affordance without rerendering the chat owner per change", async () => {
		let parentRenders = 0;
		let latest = "";
		let reset!: (value: string) => void;
		function Parent() {
			parentRenders++;
			const [external, setExternal] = useState({ value: "", revision: 0 });
			reset = (value) => setExternal((previous) => ({ value, revision: previous.revision + 1 }));
			return (
				<ChatSessionComposer
					busy={false}
					value={external.value}
					revision={external.revision}
					onChange={(value) => { latest = value; }}
					onSend={() => {}}
					onStop={() => {}}
					sendAllowed
					dictationActive={false}
				/>
			);
		}

		const host = await mount(<Parent />);
		const editor = host.querySelector<HTMLElement>("[data-file-path-input]");
		assert.ok(editor);
		await typeText(editor, "dictated phrase");
		assert.equal(readPathInput(editor), "dictated phrase");
		assert.equal(latest, "dictated phrase");
		assert.equal(parentRenders, 1, "typing only renders the local composer subtree");
		assert.equal(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled, false);

		await act(async () => { reset("restored draft"); });
		assert.equal(readPathInput(editor), "restored draft", "explicit external resets still reach PathInput");
		assert.equal(parentRenders, 2);
	});

	it("updates reading thoughts locally while forwarding drafts for submit", async () => {
		let parentRenders = 0;
		let latest = "";
		let reset!: (value: string) => void;
		function Parent() {
			parentRenders++;
			const [external, setExternal] = useState({ value: "", revision: 0 });
			reset = (value) => setExternal((previous) => ({ value, revision: previous.revision + 1 }));
			return (
				<ReadingThinkingField
					value={external.value}
					revision={external.revision}
					onChange={(value) => { latest = value; }}
					claim={false}
				/>
			);
		}

		const host = await mount(<Parent />);
		const editor = host.querySelector<HTMLElement>("[data-file-path-input]");
		assert.ok(editor);
		await typeText(editor, "thinking while reading");
		assert.equal(readPathInput(editor), "thinking while reading");
		assert.equal(latest, "thinking while reading");
		assert.equal(parentRenders, 1, "typing doesn't rerender the chat owner");

		await act(async () => { reset("restored thought"); });
		assert.equal(readPathInput(editor), "restored thought", "explicit per-question resets still reach PathInput");
		assert.equal(parentRenders, 2);
	});
});
