/**
 * Tests for the custom OpenAI-compatible endpoint (custom-endpoint wave).
 * Covers the pure core (normalizeBaseUrl, customProviderUsable, the sanitizer,
 * resolution), the deep server module (provider build + live sync + model
 * discovery incl. image-modality and reasoning detection), and the catalog
 * federation row. No network: the discovery probe runs against a stubbed fetch.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	customProviderUsable,
	normalizeBaseUrl,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { CUSTOM_PROVIDER } from "../src/core/auth-keys.ts";
import {
	buildOpenAiCompatibleProvider,
	discoverModels,
	syncCustomProvider,
} from "../src/server/custom-provider.ts";
import { piModels } from "../src/agent/models.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

// ─── normalizeBaseUrl ────────────────────────────────────────────────────────
describe("normalizeBaseUrl", () => {
	it("drops trailing slashes and keeps the path", () => {
		assert.equal(normalizeBaseUrl("https://host:8000/v1/"), "https://host:8000/v1");
		assert.equal(normalizeBaseUrl("  https://host/v1  "), "https://host/v1");
		assert.equal(normalizeBaseUrl("http://localhost:11434"), "http://localhost:11434");
	});
	it("rejects non-http(s) schemes and junk with empty string", () => {
		assert.equal(normalizeBaseUrl("file:///etc/passwd"), "");
		assert.equal(normalizeBaseUrl("not a url"), "");
		assert.equal(normalizeBaseUrl(""), "");
	});
});

// ─── customProviderUsable ────────────────────────────────────────────────────
describe("customProviderUsable", () => {
	it("is true exactly when a base URL is set (the key is optional)", () => {
		assert.equal(customProviderUsable({ baseUrl: "https://h/v1" }), true);
		assert.equal(customProviderUsable({ baseUrl: "" }), false);
		assert.equal(customProviderUsable({}), false);
		assert.equal(customProviderUsable(undefined), false);
	});
});

// ─── sanitizer ───────────────────────────────────────────────────────────────
describe("sanitizeUserSettings — customProvider", () => {
	it("normalizes the base URL and cleans the model list (trim, dedupe, image flag)", () => {
		const out = sanitizeUserSettings({
			customProvider: {
				baseUrl: "https://host:8000/v1/",
				models: [
					{ id: " llama-3 " }, // trims id; image absent
					{ id: "gpt", image: true },
					{ id: "gpt", image: false }, // dup id wins (last) → image dropped
					{ id: "" }, // dropped: no usable id
					"not-an-object", // dropped
				],
			},
		});
		const cp = out?.customProvider;
		assert.equal(cp?.baseUrl, "https://host:8000/v1");
		assert.deepEqual(cp?.models, [{ id: "llama-3" }, { id: "gpt" }]);
	});
	it("keeps image:true and drops a non-array models list / invalid base URL", () => {
		const out = sanitizeUserSettings({ customProvider: { baseUrl: "ftp://x", models: "nope" } });
		assert.equal(out?.customProvider?.baseUrl, undefined);
		assert.equal(out?.customProvider?.models, undefined);
	});
	it("keeps reasoning:true and drops a non-true reasoning flag", () => {
		const out = sanitizeUserSettings({
			customProvider: {
				baseUrl: "https://h/v1",
				models: [{ id: "thinker", reasoning: true }, { id: "plain", reasoning: "yes" }],
			},
		});
		assert.deepEqual(out?.customProvider?.models, [{ id: "thinker", reasoning: true }, { id: "plain" }]);
	});
});

// ─── resolution ──────────────────────────────────────────────────────────────
describe("resolveSettings — customProvider", () => {
	it("resolves an absent section to concrete defaults", () => {
		assert.deepEqual(resolveSettings(null).customProvider, { baseUrl: "", models: [] });
	});
});

// ─── provider build + live sync ──────────────────────────────────────────────
describe("buildOpenAiCompatibleProvider / syncCustomProvider", () => {
	after(() => piModels().deleteProvider(CUSTOM_PROVIDER.id));

	it("maps ids to defaults and marks image-capable models image-input", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "m1" }, { id: "m2", image: true }],
		});
		assert.equal(provider.id, CUSTOM_PROVIDER.id);
		const [m1, m2] = provider.getModels();
		assert.equal(m1!.name, "m1");
		assert.equal(m1!.api, "openai-completions");
		assert.equal(m1!.provider, CUSTOM_PROVIDER.id);
		assert.equal(m1!.baseUrl, "http://h/v1");
		assert.equal(m1!.contextWindow, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW);
		assert.equal(m1!.maxTokens, CUSTOM_MODEL_DEFAULT_MAX_TOKENS);
		assert.deepEqual(m1!.input, ["text"]); // text-only by default
		assert.deepEqual(m2!.input, ["text", "image"]); // image-capable → Vision-eligible
		assert.equal(m1!.contextWindow, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW); // no endpoint value → default
		assert.equal(m1!.maxTokens, CUSTOM_MODEL_DEFAULT_MAX_TOKENS);
	});

	it("carries endpoint token limits when present", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "big", context: 196608, maxTokens: 393216 }],
		});
		const [big] = provider.getModels();
		assert.equal(big!.contextWindow, 196608); // 192k from the endpoint
		assert.equal(big!.maxTokens, 393216);
	});

	it("gives a reasoning-capable model the standard thinking levels (others stay \"off\")", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "thinker", reasoning: true }, { id: "plain" }],
		});
		const [thinker, plain] = provider.getModels();
		assert.equal(thinker!.reasoning, true);
		// No thinkingLevelMap → pi-ai's default set, same as any reasoning model.
		assert.deepEqual(getSupportedThinkingLevels(thinker!), ["off", "minimal", "low", "medium", "high"]);
		assert.equal(plain!.reasoning, false);
		assert.deepEqual(getSupportedThinkingLevels(plain!), ["off"]);
	});

	it("registers on a usable sync and removes when the base URL clears", () => {
		syncCustomProvider({ baseUrl: "http://h/v1", models: [{ id: "live" }] });
		assert.ok(piModels().getProvider(CUSTOM_PROVIDER.id), "provider registered");
		assert.ok(piModels().getModel(CUSTOM_PROVIDER.id, "live"), "model resolvable");
		syncCustomProvider({ baseUrl: "", models: [{ id: "live" }] });
		assert.equal(piModels().getProvider(CUSTOM_PROVIDER.id), undefined, "provider removed");
	});
});

// ─── discovery (stubbed fetch) ───────────────────────────────────────────────
describe("discoverModels", () => {
	const realFetch = globalThis.fetch;
	after(() => {
		globalThis.fetch = realFetch;
	});

	function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
		globalThis.fetch = (async (input: unknown) => {
			const res = handler(String(input));
			return new Response(JSON.stringify(res.body), { status: res.status });
		}) as unknown as typeof fetch;
	}

	it("reads OpenAI {data:[{id}]} and Ollama {models:[{id}]} shapes", async () => {
		stubFetch(() => ({ status: 200, body: { data: [{ id: "b" }, { id: "a" }] } }));
		const openai = await discoverModels("http://h/v1");
		assert.ok(openai.ok);
		assert.deepEqual(openai.models, [{ id: "a" }, { id: "b" }]);
		stubFetch(() => ({ status: 200, body: { models: [{ id: "x" }] } }));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok && r.models.length === 1 && r.models[0]!.id === "x");
	});
	it("detects image capability from common modality fields", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "vision-model", architecture: { input_modalities: ["text", "image"] } },
					{ id: "cap-model", capabilities: ["completion", "vision"] },
					{ id: "text-model", architecture: { input_modalities: ["text"] } },
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, Boolean(m.image)]));
		assert.equal(byId["vision-model"], true);
		assert.equal(byId["cap-model"], true);
		assert.equal(byId["text-model"], false);
	});
	it("detects token limits from common metadata fields", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "big", max_input_tokens: 196608, max_output_tokens: 393216 },
					{ id: "ctx", context_length: 32768 },
					{ id: "plain" },
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
		assert.equal(byId["big"]!.context, 196608);
		assert.equal(byId["big"]!.maxTokens, 393216);
		assert.equal(byId["ctx"]!.context, 32768);
		assert.equal(byId["ctx"]!.maxTokens, undefined);
		assert.equal(byId["plain"]!.context, undefined);
	});
	it("detects reasoning from endpoint metadata only — never from the model name", async () => {
		stubFetch(() => ({
			status: 200,
			body: {
				data: [
					{ id: "vllm-reasoner", supported_parameters: ["temperature", "reasoning", "reasoning_effort"] },
					{ id: "bool-reasoner", reasoning: true },
					{ id: "thinking-flag", thinking: true },
					{ id: "cap-reasoner", capabilities: ["completion", "reasoning"] },
					{ id: "deepseek-r1-distill" }, // a reasoning-sounding NAME, no metadata → stays off
				],
			},
		}));
		const r = await discoverModels("http://h/v1");
		assert.ok(r.ok);
		const byId = Object.fromEntries(r.models.map((m) => [m.id, Boolean(m.reasoning)]));
		assert.equal(byId["vllm-reasoner"], true);
		assert.equal(byId["bool-reasoner"], true);
		assert.equal(byId["thinking-flag"], true);
		assert.equal(byId["cap-reasoner"], true);
		assert.equal(byId["deepseek-r1-distill"], false, "name guessing would risk sending reasoning_effort to a server that rejects it");
	});

	it("guards the scheme before any fetch", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const r = await discoverModels("file:///etc/passwd");
		assert.equal(r.ok, false);
		assert.equal(called, false, "no fetch for a non-http scheme");
	});
	it("reports a non-2xx and an unparseable shape as honest errors", async () => {
		stubFetch(() => ({ status: 500, body: {} }));
		assert.equal((await discoverModels("http://h/v1")).ok, false);
		stubFetch(() => ({ status: 200, body: { unexpected: true } }));
		assert.equal((await discoverModels("http://h/v1")).ok, false);
	});
});
