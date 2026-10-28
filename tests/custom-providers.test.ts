import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseCustomProviders, resolveCustomValue } from "../src/core/custom-providers.ts";
import { createCustomProvider, customProviderApis } from "../src/agent/custom-providers.ts";
import { CLAUDE_CODE_PROVIDER } from "../src/core/contracts/claude-code.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function model(id = "chat", extra = {}) {
	return { id, contextWindow: 8192, maxTokens: 1024, cost: zero, ...extra };
}
function config(extra = {}, models = [model()]) {
	return { providers: { gateway: { baseUrl: "http://example.invalid/custom/v1", api: "openai-completions", apiKey: "dummy", models, ...extra } } };
}
function parse(value: unknown) { return parseCustomProviders(JSON.stringify(value), new Set(["openai", "chatgpt"]), customProviderApis); }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-providers-"));
process.env.LH_DATA_DIR = temp;
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
fs.writeFileSync(process.env.LH_AUTH_FILE, JSON.stringify({ GW_KEY: "first-key", GW_HEADER: "first-header" }));
const { CUSTOM_MODELS_FILE, SETTINGS_FILE } = await import("../config.ts");
const { modelCatalog, validateModelsSettings, clampModelsLevels, catalogContextLimits } = await import("../src/server/model-catalog.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { providerKeyPresent, keyValue } = await import("../src/server/keys.ts");
const { authStore } = await import("../src/store/auth.ts");
const { CustomProviderSource, customProviderConfigured, installCustomProviderSource } = await import("../src/server/custom-providers.ts");
const { callCost } = await import("../src/server/pricing.ts");
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function save(value: unknown) { fs.writeFileSync(CUSTOM_MODELS_FILE, JSON.stringify(value)); }
function sseText(text = "ok") {
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
	];
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "chat", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

describe("declarative custom-provider configuration", () => {
	it("uses Pi metadata and provider/model inheritance without rewriting base URLs", () => {
		const [parsed] = parse(config({ compat: { supportsStore: false, chatTemplateKwargs: { a: true } } }, [model("named", {
			name: "Named model", reasoning: true, input: ["text", "image"], thinkingLevelMap: { high: "high", xhigh: null },
			compat: { maxTokensField: "max_tokens", chatTemplateKwargs: { b: false } },
			samplingParams: { temperature: 0.5 }, samplingParamsByThinkingLevel: { high: { top_p: 0.9 } },
		})]));
		assert.equal(parsed!.models[0]!.baseUrl, "http://example.invalid/custom/v1");
		assert.equal(parsed!.models[0]!.provider, "gateway");
		assert.equal(parsed!.models[0]!.name, "Named model");
		assert.deepEqual(parsed!.models[0]!.input, ["text", "image"]);
		assert.deepEqual(parsed!.models[0]!.compat, { supportsStore: false, maxTokensField: "max_tokens", chatTemplateKwargs: { a: true, b: false } });
		assert.deepEqual(parsed!.models[0]!.samplingParamsByThinkingLevel, { high: { top_p: 0.9 } });
	});
	it("accepts Pi line comments, trailing commas and BOM without corrupting strings", () => {
		const text = `\uFEFF${JSON.stringify(config()).replace('"providers":', '// comment\n"providers":').replace(/}$/, ',}')}`;
		assert.equal(parseCustomProviders(text, new Set(), customProviderApis)[0]!.models[0]!.baseUrl, "http://example.invalid/custom/v1");
	});
	it("registers multiple providers and mixed native APIs without fixed backend IDs", () => {
		const value = config();
		const raw = { providers: { ...value.providers, other: { ...value.providers.gateway, models: [model("chat"), model("anthropic", { api: "anthropic-messages", baseUrl: "https://example.invalid/anthropic" })] } } };
		const models = createModels();
		for (const entry of parse(raw)) models.setProvider(createCustomProvider(entry, () => undefined));
		assert.equal(models.getProviders().length, 2);
		assert.equal(models.getModel("other", "anthropic")!.api, "anthropic-messages");
		assert.equal(models.getModel("other", "anthropic")!.baseUrl, "https://example.invalid/anthropic");
	});
	it("requires explicit finite limits and nonnegative costs, instead of guessing", () => {
		for (const field of ["contextWindow", "maxTokens", "cost"]) {
			const m: Record<string, unknown> = model(); delete m[field];
			assert.throws(() => parse(config({}, [m as ReturnType<typeof model>])));
		}
		assert.throws(() => parse(config({}, [model("chat", { contextWindow: -1 })])));
		assert.throws(() => parse(config({}, [model("chat", { cost: { ...zero, output: -1 } })])));
		assert.throws(() => parseCustomProviders(JSON.stringify(config()).replace('"contextWindow":8192', '"contextWindow":1e999'), new Set(), customProviderApis));
	});
	it("rejects collisions, duplicate IDs, unsupported protocols, executable fields and invalid URLs", () => {
		for (const id of ["openai", "chatgpt", "", "has:colon"]) assert.throws(() => parse({ providers: { [id]: config().providers.gateway } }));
		assert.throws(() => parse(config({}, [model(), model()])));
		assert.throws(() => parse(config({ api: "unknown-api" })));
		assert.throws(() => parse(config({ oauth: "radius" })));
		assert.throws(() => parse(config({ modelOverrides: {} })));
		assert.throws(() => parse(config({ apiKey: "!touch /never-execute" })));
		assert.throws(() => parse(config({ headers: { "x-key": "!secret-command" } })));
		assert.throws(() => parse(config({}, [model("chat", { headers: { Authorization: "!command" } })])));
		for (const baseUrl of ["file:///tmp/model", "https://secret@example.invalid", "http://example.invalid/#fragment"]) assert.throws(() => parse(config({ baseUrl })));
	});
	it("matches Pi value interpolation and escapes, without recursive expansion or commands", () => {
		const lookup = (key: string) => ({ KEY: "secret", DATA: "!never-executed" })[key as "KEY"];
		assert.equal(resolveCustomValue("Bearer ${KEY}/$KEY", lookup), "Bearer secret/secret");
		assert.equal(resolveCustomValue("$$KEY $!literal", lookup), "$KEY !literal");
		assert.equal(resolveCustomValue("$MISSING", lookup), undefined);
		assert.equal(resolveCustomValue("$DATA", lookup), "!never-executed");
	});
});

describe("custom providers in the existing application wiring", () => {
	it("is empty before configuration and never creates a configuration file", () => {
		assert.equal(fs.existsSync(CUSTOM_MODELS_FILE), false);
		assert.equal(modelCatalog().customProvidersError, undefined);
		assert.equal(fs.existsSync(CUSTOM_MODELS_FILE), false);
	});
	it("projects into existing pickers, validation, context limits and Pi pricing", async () => {
		save(config({ apiKey: "$GW_KEY", headers: { "x-gateway": "$GW_HEADER" } }, [model("chat", { cost: { ...zero, input: 2, output: 4 } })]));
		const catalog = modelCatalog();
		assert.ok(catalog.providers.find((p) => p.id === "gateway")?.keyPresent);
		assert.ok(catalog.models.some((m) => m.provider === "gateway" && m.id === "chat"));
		assert.equal(JSON.stringify(catalog).includes("first-key"), false);
		assert.equal(JSON.stringify(catalog).includes("first-header"), false);
		assert.equal(validateModelsSettings({ strong: { model: { provider: "gateway", id: "chat" } } }).ok, true);
		assert.equal(catalogContextLimits().get("gateway:chat"), 8192);
		assert.ok(Math.abs(callCost({ inputTokens: 100, outputTokens: 50 }, "gateway:chat")! - 0.0004) < 1e-12);
		assert.equal(providerKeyPresent("gateway"), true);
		assert.equal((await piModels().getAuth("gateway"))!.auth.apiKey, "first-key");
	});
	it("uses current app key precedence and marks unresolved credentials/headers unavailable", () => {
		process.env.LH_IGNORE_ENV_KEYS = "0";
		process.env.GW_KEY = "real-env-key";
		try { assert.equal(keyValue("GW_KEY"), "real-env-key"); }
		finally { process.env.LH_IGNORE_ENV_KEYS = "1"; delete process.env.GW_KEY; }
		save(config({ apiKey: "$MISSING_KEY" }));
		assert.equal(providerKeyPresent("gateway"), false);
		assert.equal(modelCatalog().models.some((m) => m.provider === "gateway"), false);
		save(config({ headers: { "x-required": "$MISSING_HEADER" } }));
		assert.equal(providerKeyPresent("gateway"), false);
		save(config({ apiKey: undefined }));
		assert.equal(providerKeyPresent("gateway"), false, "Pi-style keyless endpoints need an explicit dummy key");
	});
	it("revalidates every request of one engine while leaving an in-flight HTTP operation alone", async () => {
		save(config({ apiKey: "$GW_KEY", headers: { "x-gateway": "$GW_HEADER" }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } }));
		const engine = piEngineForSpec({ provider: "gateway", id: "chat" });
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		let started!: () => void, release!: (response: Response) => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
		const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			requests.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
			if (requests.length === 1) { started(); return firstResponse; }
			return sseText("héllo 🌍");
		};
		const pending = engine.streamFn(engine.model, context);
		try {
			await requestStarted;
			authStore.setAuthVar("GW_KEY", "second-key");
			authStore.setAuthVar("GW_HEADER", "second-header");
			save(config({ baseUrl: "https://new.example.invalid/inference/v1", apiKey: "$GW_KEY", headers: { "x-gateway": "$GW_HEADER" }, compat: { supportsStore: false, maxTokensField: "max_tokens" } }, [model("chat", { maxTokens: 512 })]));
			const second = await engine.streamFn(engine.model, context).result();
			assert.equal(second.stopReason, "stop");
			assert.deepEqual(second.content, [{ type: "text", text: "héllo 🌍" }]);
			assert.equal(second.usage.input, 10);
			assert.equal(second.usage.output, 2);
			// Credential-only edits must also take effect on this same engine.
			authStore.setAuthVar("GW_KEY", "third-key");
			assert.equal((await engine.streamFn(engine.model, context).result()).stopReason, "stop");
			// None of these cases may dispatch using the engine's old model/key.
			save(config({ apiKey: "$MISSING_KEY" }));
			assert.equal((await engine.streamFn(engine.model, context).result()).stopReason, "error");
			save(config({}, [model("other-model")]));
			assert.equal((await engine.streamFn(engine.model, context).result()).stopReason, "error");
			fs.writeFileSync(CUSTOM_MODELS_FILE, "invalid configuration");
			assert.equal((await engine.streamFn(engine.model, context).result()).stopReason, "error");
			fs.rmSync(CUSTOM_MODELS_FILE);
			assert.equal((await engine.streamFn(engine.model, context).result()).stopReason, "error");
			release(sseText("original request finished"));
			const first = await pending.result();
			assert.equal(first.stopReason, "stop");
			assert.deepEqual(first.content, [{ type: "text", text: "original request finished" }]);
		} finally {
			release(sseText());
			await pending.result();
			globalThis.fetch = original;
		}
		assert.equal(requests.length, 3, "unavailable configurations must not cause additional transport calls");
		assert.equal(requests[0]!.url, "http://example.invalid/custom/v1/chat/completions");
		assert.equal(requests[0]!.headers.get("authorization"), "Bearer first-key");
		assert.equal(requests[0]!.headers.get("x-gateway"), "first-header");
		assert.equal(requests[1]!.url, "https://new.example.invalid/inference/v1/chat/completions");
		assert.equal(requests[1]!.headers.get("authorization"), "Bearer second-key");
		assert.equal(requests[1]!.headers.get("x-gateway"), "second-header");
		assert.equal(requests[2]!.headers.get("authorization"), "Bearer third-key");
		assert.equal(requests[0]!.body.model, "chat");
		assert.equal("store" in requests[0]!.body, false);
		assert.equal(requests[0]!.body.max_tokens, 1024);
		assert.equal(requests[1]!.body.max_tokens, 512, "current Pi model metadata, not the stale engine model, controls the request");
	});
	const thinking = (...levels: ThinkingLevel[]) => ({
		reasoning: true,
		// Pi treats omitted levels through high as supported; mark every
		// unselected level explicitly unsupported for these narrow fixtures.
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null, ...Object.fromEntries(levels.map((level) => [level, level])) },
	});
	const thinkingCases: { name: string; preference?: ThinkingLevel; initial: object; updated: object; before: ThinkingLevel; after: ThinkingLevel }[] = [
		{ name: "recovers saved max after high-only metadata expands", preference: "max", initial: thinking("high"), updated: thinking("high", "max"), before: "high", after: "max" },
		{ name: "recovers saved max after reasoning-off metadata expands", preference: "max", initial: { reasoning: false }, updated: thinking("high", "max"), before: "off", after: "max" },
		{ name: "selects the existing medium-first default after reasoning becomes supported", initial: { reasoning: false }, updated: thinking("low", "medium", "high"), before: "off", after: "medium" },
		{ name: "reselects the existing low-before-high default against updated metadata", initial: thinking("high"), updated: thinking("low", "high"), before: "high", after: "low" },
		{ name: "clamps saved max when supported thinking contracts", preference: "max", initial: thinking("high", "max"), updated: thinking("high"), before: "max", after: "high" },
		{ name: "omits reasoning when the model loses thinking support", preference: "max", initial: thinking("high", "max"), updated: { reasoning: false }, before: "max", after: "off" },
	];
	for (const scenario of thinkingCases) it(scenario.name, async () => {
		const definition = (metadata: object) => config({ compat: { supportsReasoningEffort: true, thinkingFormat: "openai" } }, [model("chat", metadata)]);
		save(definition(scenario.initial));
		const engine = piEngineForSpec({ provider: "gateway", id: "chat", thinkingLevel: scenario.preference });
		assert.equal(engine.level, scenario.before);
		const requests: Record<string, unknown>[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			requests.push(await request.json() as Record<string, unknown>);
			return sseText();
		};
		try {
			const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
			// A long-lived agent still forwards its initial thinking setting.
			const options: SimpleStreamOptions = { reasoning: engine.level === "off" ? undefined : engine.level };
			assert.equal((await engine.streamFn(engine.model, context, options).result()).stopReason, "stop");
			save(definition(scenario.updated));
			assert.equal((await engine.streamFn(engine.model, context, options).result()).stopReason, "stop");
		} finally { globalThis.fetch = original; }
		assert.equal(requests.length, 2);
		for (const [index, level] of [scenario.before, scenario.after].entries()) {
			assert.equal(requests[index]!.reasoning_effort, level === "off" ? undefined : level);
			if (level === "off") assert.equal("reasoning_effort" in requests[index]!, false);
		}
	});
	it("disables custom routes on malformed edits without removing built-ins or saved choices", () => {
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, models: { strong: { model: { provider: "gateway", id: "chat" }, thinkingLevel: "high" } } }));
		const before = fs.readFileSync(SETTINGS_FILE, "utf8");
		fs.writeFileSync(CUSTOM_MODELS_FILE, '{ secret-token-do-not-log');
		const catalog = modelCatalog();
		assert.ok(catalog.customProvidersError);
		assert.equal(catalog.customProvidersError!.includes("secret-token"), false);
		assert.equal(piModels().getProvider("gateway"), undefined);
		assert.ok(piModels().getProvider("openai"));
		assert.deepEqual(catalog.slots.strong!.model, { provider: "gateway", id: "chat" });
		const stored = { strong: { model: { provider: "gateway", id: "chat" }, thinkingLevel: "high" as const } };
		const repaired = { strong: { ...stored.strong, thinkingLevel: "max" as const }, cheap: { model: { provider: "openai", id: piModels().getModels("openai")[0]!.id } } };
		assert.equal(validateModelsSettings(repaired, stored).ok, true, "an unavailable custom pin must not prevent independent slot repair");
		assert.equal(clampModelsLevels(repaired).strong!.thinkingLevel, "max", "preserve thinking while custom metadata is unavailable");
		assert.equal(validateModelsSettings({ cheap: stored.strong }, stored).ok, false, "unchanged identity preservation is same-slot only");
		assert.equal(fs.readFileSync(SETTINGS_FILE, "utf8"), before);
		assert.throws(() => piEngineForSpec({ provider: "gateway", id: "chat" }), /catalog has no model/);
		save(config());
		assert.equal(modelCatalog().customProvidersError, undefined);
		assert.ok(piModels().getProvider("gateway"));
		fs.rmSync(CUSTOM_MODELS_FILE);
		assert.equal(modelCatalog().models.some((m) => m.provider === "gateway"), false);
		assert.equal(modelCatalog().customProvidersError, undefined);
		assert.equal(fs.readFileSync(SETTINGS_FILE, "utf8"), before);
	});
	it("refreshes credentials without a file edit, preserving native header precedence and snapshots", async () => {
		const values = new Map([["KEY", "one"], ["HEADER", "first"]]);
		const source = new CustomProviderSource(() => ({ text: JSON.stringify(config({ apiKey: "$KEY", authHeader: true, headers: { "x-shared": "$HEADER" } }, [model("chat", { headers: { "x-shared": "model-${HEADER}" } })])) }), (name) => values.get(name));
		const models = createModels();
		source.sync(models);
		const captured = createModels();
		captured.setProvider(models.getProvider("gateway")!);
		values.set("KEY", "two"); values.set("HEADER", "second");
		source.sync(models);
		const current = (await models.getAuth(models.getModel("gateway", "chat")!))!.auth;
		const previous = (await captured.getAuth(captured.getModel("gateway", "chat")!))!.auth;
		assert.equal(current.apiKey, "two");
		assert.equal(current.headers!["x-shared"], "model-second");
		assert.equal(current.headers!.Authorization, "Bearer two");
		assert.equal(previous.apiKey, "one");
		assert.equal(previous.headers!["x-shared"], "model-first");
	});
	it("rejects built-in, subscription and native CLI collisions without replacing their providers", () => {
		for (const id of ["openai", "github-copilot", "chatgpt", "github-copilot-subscription", "xai-subscription", CLAUDE_CODE_PROVIDER]) {
			const existing = piModels().getProvider("openai")!;
			const nativeCli = piModels().getProvider(CLAUDE_CODE_PROVIDER)!;
			const models = createModels(); models.setProvider(existing); models.setProvider(nativeCli);
			const source = new CustomProviderSource(() => ({ text: JSON.stringify({ providers: { [id]: config().providers.gateway } }) }), () => undefined);
			source.sync(models);
			assert.ok(source.getError());
			assert.equal(models.getProvider("openai"), existing);
			assert.equal(models.getProvider(CLAUDE_CODE_PROVIDER), nativeCli);
			assert.equal(models.getProviders().length, 2);
		}
	});
	it("cannot bypass CLI opt-in or replace/remove the native provider across custom configuration reloads", (t) => {
		const nativeCli = piModels().getProvider(CLAUDE_CODE_PROVIDER)!;
		assert.ok(nativeCli);
		const aliases = piModels().getModels(CLAUDE_CODE_PROVIDER);
		const savedConfig = fs.existsSync(CUSTOM_MODELS_FILE) ? fs.readFileSync(CUSTOM_MODELS_FILE, "utf8") : undefined;
		const savedSettings = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, "utf8") : undefined;
		t.after(() => {
			if (savedConfig === undefined) fs.rmSync(CUSTOM_MODELS_FILE, { force: true }); else fs.writeFileSync(CUSTOM_MODELS_FILE, savedConfig);
			if (savedSettings === undefined) fs.rmSync(SETTINGS_FILE, { force: true }); else fs.writeFileSync(SETTINGS_FILE, savedSettings);
			piModels();
		});
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ version: 1, claudeCode: { enabled: false } }));
		const collision = { providers: { [CLAUDE_CODE_PROVIDER]: config().providers.gateway } };
		for (const [value, error] of [
			[collision, true], // Initial collision must never enter registered/ready.
			[config(), false], // A normal custom route still works.
			[collision, true], // Invalid reload retires custom routes, not native ones.
			["malformed configuration", true],
			[undefined, false], // Removing the file must not delete the native CLI.
			[config(), false],
			[undefined, false],
		] as const) {
			if (value === undefined) fs.rmSync(CUSTOM_MODELS_FILE, { force: true });
			else if (typeof value === "string") fs.writeFileSync(CUSTOM_MODELS_FILE, value);
			else save(value);
			const catalog = modelCatalog();
			assert.equal(Boolean(catalog.customProvidersError), error);
			assert.equal(customProviderConfigured(CLAUDE_CODE_PROVIDER), undefined);
			assert.equal(providerKeyPresent(CLAUDE_CODE_PROVIDER), false, "custom auth must never bypass disabled CLI admission");
			assert.equal(piModels().getProvider(CLAUDE_CODE_PROVIDER), nativeCli, "preserve the native provider identity, not a reconstructed substitute");
			assert.deepEqual(piModels().getModels(CLAUDE_CODE_PROVIDER), aliases);
			assert.equal(catalog.models.some((m) => m.provider === CLAUDE_CODE_PROVIDER), false);
		}
	});
	it("fails closed across partial publication and recovers without leaking internal errors", () => {
		const text = JSON.stringify({ providers: { ...config().providers, second: config().providers.gateway } });
		const source = new CustomProviderSource(() => ({ text }), () => undefined);
		const models = createModels();
		const builtin = piModels().getProvider("openai")!;
		models.setProvider(builtin);
		const publish = models.setProvider.bind(models);
		models.setProvider = (provider) => {
			if (provider.id === "second") throw new Error("private-value-do-not-log");
			publish(provider);
		};
		source.sync(models);
		assert.equal(models.getProvider("gateway"), undefined);
		assert.equal(models.getProvider("second"), undefined);
		assert.equal(models.getProvider("openai"), builtin);
		assert.equal(source.getError()!.includes("private-value"), false);
		models.setProvider = publish;
		source.sync(models);
		assert.ok(models.getProvider("gateway"));
		assert.ok(models.getProvider("second"));
		assert.equal(source.getError(), undefined);
	});
	it("retires old custom routes when server configuration bootstrap is reinstalled", () => {
		save(config());
		assert.ok(piModels().getProvider("gateway"));
		fs.rmSync(CUSTOM_MODELS_FILE);
		installCustomProviderSource(keyValue);
		assert.equal(piModels().getProvider("gateway"), undefined);
		assert.ok(piModels().getProvider("openai"));
	});
	it("treats unreadable config as unavailable and recovers without a restart", () => {
		let unreadable = true;
		const source = new CustomProviderSource(() => unreadable ? { error: "Unable to read models.json." } : { text: JSON.stringify(config()) }, () => undefined);
		const models = createModels();
		source.sync(models);
		assert.equal(source.getError(), "Unable to read models.json.");
		unreadable = false;
		source.sync(models);
		assert.ok(models.getProvider("gateway"));
		assert.equal(source.getError(), undefined);
	});
});
