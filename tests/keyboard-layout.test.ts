import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionForBinding, eventBinding } from "../src/core/keyboard.ts";

/**
 * Non-Latin keyboard layouts: with Ctrl/Cmd held, a Cyrillic (or Greek,
 * Hebrew, …) layout reports the LAYOUT's character in `key` — Ctrl+K on a
 * Russian layout is key "л" — so every letter shortcut went dead until the
 * learner switched back to a Latin layout. A modified letter whose `key` is
 * not ASCII falls back to its physical key (`code` KeyK → "k"); Latin
 * layouts (including AZERTY/Dvorak, where `key` is already the intended
 * letter) are untouched.
 */

function press(init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
	return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

describe("eventBinding — non-Latin layouts", () => {
	it("Ctrl+K on a Russian layout is the model selector, as on a Latin layout", () => {
		const binding = eventBinding(press({ key: "л", code: "KeyK", ctrlKey: true }));
		assert.equal(binding, "mod+k");
		assert.equal(actionForBinding(binding), "open-model-picker");
	});

	it("shift stays explicit: Ctrl+Shift+F on a Russian layout is the sessions search", () => {
		const binding = eventBinding(press({ key: "А", code: "KeyF", ctrlKey: true, shiftKey: true }));
		assert.equal(binding, "mod+shift+f");
		assert.equal(actionForBinding(binding), "sessions-search");
	});

	it("Cmd+, on a Russian layout (key \"б\") opens settings", () => {
		const binding = eventBinding(press({ key: "б", code: "Comma", metaKey: true }));
		assert.equal(binding, "mod+,");
		assert.equal(actionForBinding(binding), "open-settings");
	});

	it("a Latin layout keeps following `key`, not the physical position (AZERTY: the A key types q)", () => {
		assert.equal(eventBinding(press({ key: "q", code: "KeyA", ctrlKey: true })), "mod+q");
		assert.equal(eventBinding(press({ key: "k", code: "KeyK", ctrlKey: true })), "mod+k");
	});

	it("bare non-Latin typing is not a binding to rewrite", () => {
		assert.equal(eventBinding(press({ key: "л", code: "KeyK" })), "л");
	});
});
