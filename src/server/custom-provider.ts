/**
 * THE CUSTOM OPENAI-COMPATIBLE ENDPOINT (custom-endpoint wave): the deep
 * module that turns the user's non-secret config (base URL + discovered model
 * ids, core/settings.ts `customProvider`) into a real pi-ai provider registered
 * in the process-wide `piModels()` collection — so its models fill the same
 * strong/cheap/vision slots and background roles as any built-in.
 *
 * WHY A MODULE OWNS THIS (information hiding): the fact "a custom endpoint is
 * an OpenAI-completions provider at a user URL with an optional key" would
 * otherwise leak into the catalog, the keys seam, and the settings route. It
 * lives here instead; those surfaces consult the pure `customProviderUsable`
 * predicate (core) and call `syncCustomProvider`. The single-endpoint scope is
 * special-purpose, but the builder is written general (`buildOpenAiCompatible
 * Provider`) so a future multi-endpoint wave reuses it unchanged.
 *
 * LIFECYCLE (no restart, mirroring the keys seam): `syncCustomProvider` is
 * idempotent and cheap — called at boot (stores.ts, the composition root) and
 * after every connect (POST /api/custom-provider). It replaces
 * or removes the provider in `piModels()` by id. The base URL is fixed at
 * provider construction, so a base-URL change is a rebuild — which is exactly
 * what a re-sync does.
 *
 * AUTH: pi-ai resolves a provider's key at request time. We read the reserved
 * env var through the keys seam (`keyValue` — env-wins, file fallback, honors
 * the fresh-user switch), and fall back to a placeholder when none is set so
 * KEYLESS local servers (Ollama / LM Studio / llama.cpp) work. The placeholder
 * is an internal detail of `resolve()` — no caller ever sees it.
 */

import { createProvider, type ApiKeyAuth, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { piModels } from "../agent/models.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	customProviderUsable,
	normalizeBaseUrl,
	type CustomModel,
	type CustomProviderSettings,
} from "../core/settings.ts";
import { keyValue } from "./keys.ts";

/** Placeholder bearer sent to keyless endpoints. Many local OpenAI-compatible
 *  servers ignore the Authorization header entirely; the OpenAI client still
 *  requires *a* key, so we hand it this. Never shown to the user. */
const KEYLESS_PLACEHOLDER = "not-needed";

/** Narrow an unknown to a plain object (not null, not an array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The custom endpoint's auth: resolve the reserved key through the keys
 *  seam, else the keyless placeholder. `resolve` is the only method pi-ai
 *  needs to treat the provider as configured. */
const customEndpointAuth: ApiKeyAuth = {
	name: `${CUSTOM_PROVIDER.label} API key`,
	resolve: async () => {
		const key = keyValue(CUSTOM_PROVIDER.envVar)?.trim();
		// Keyless local servers ignore the header; the OpenAI client still
		// needs *a* key, so hand it the placeholder.
		return { auth: { apiKey: key || KEYLESS_PLACEHOLDER }, source: key ? CUSTOM_PROVIDER.envVar : "keyless" };
	},
};

/** Map one discovered custom model to a pi-ai chat model entry. The endpoint's
 *  /models reports ids plus whatever metadata it exposes; `image` sets `input`
 *  so a Vision-capable model is selectable for the Vision slot (PDFs, images),
 *  and `context` / `maxTokens` carry the endpoint's reported token limits.
 *  Anything the endpoint omits falls back to the CUSTOM_MODEL_DEFAULT_* values
 *  (self-hosted = free, modest window). `baseUrl` is stamped per-model (pi reads
 *  it from the model, not the provider). */
function toPiModel(model: CustomModel, baseUrl: string): Model<Api> {
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: CUSTOM_PROVIDER.id,
		baseUrl,
		reasoning: false,
		input: model.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
		type: "chat",
	};
}

/** Build a general OpenAI-compatible provider from parts (single-use today,
 *  general by design). `baseUrl` must already be normalized. */
export function buildOpenAiCompatibleProvider(input: {
	baseUrl: string;
	models: readonly CustomModel[];
}): Provider<Api> {
	return createProvider<Api>({
		id: CUSTOM_PROVIDER.id,
		name: CUSTOM_PROVIDER.label,
		baseUrl: input.baseUrl,
		auth: { apiKey: customEndpointAuth },
		models: input.models.map((m) => toPiModel(m, input.baseUrl)),
		api: openAICompletionsApi(),
	});
}

/**
 * Re-sync the custom provider into `piModels()` from the resolved section
 * (idempotent). Usable → (re)build and `setProvider` (replaces by id, so a
 * base-URL/model change lands with no restart). Not usable → `deleteProvider`
 * so it stops federating and any slot pinning one of its models falls back to
 * the honest models_not_configured refusal. Never throws: a bad config simply
 * leaves the provider absent.
 */
export function syncCustomProvider(cp: CustomProviderSettings | undefined): void {
	const models = piModels();
	if (!customProviderUsable(cp)) {
		models.deleteProvider(CUSTOM_PROVIDER.id);
		return;
	}
	// `customProviderUsable` narrowed cp to a defined section with a baseUrl.
	models.setProvider(
		buildOpenAiCompatibleProvider({ baseUrl: normalizeBaseUrl(cp.baseUrl), models: cp.models ?? [] }),
	);
}

/** Outcome of a model-discovery probe. */
export type DiscoverResult = { ok: true; models: CustomModel[] } | { ok: false; error: string };

/**
 * Probe an endpoint's `GET {baseUrl}/models` (the OpenAI list-models route)
 * and return the model ids. The scheme is validated via normalizeBaseUrl
 * (http/https only — the SSRF guard: this is a local app, but a user paste of
 * `file://` or a stray string must never reach fetch). The key rides as a
 * bearer when one is configured; keyless endpoints answer without it. A
 * non-2xx or unparseable body is an honest error, never a silent empty list.
 */
export async function discoverModels(baseUrl: string, apiKey?: string): Promise<DiscoverResult> {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) return { ok: false, error: "Base URL must be a valid http(s) URL" };
	const key = apiKey?.trim() || keyValue(CUSTOM_PROVIDER.envVar)?.trim();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(`${base}/models`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: controller.signal,
		});
		if (!res.ok) return { ok: false, error: `Endpoint returned ${res.status} ${res.statusText}` };
		const body = (await res.json().catch(() => null)) as unknown;
		const list = extractModels(body);
		if (list === null) return { ok: false, error: "Endpoint response was not a model list" };
		return { ok: true, models: list };
	} catch (err) {
		const msg = err instanceof Error ? (err.name === "AbortError" ? "Endpoint timed out" : err.message) : "Request failed";
		return { ok: false, error: msg };
	} finally {
		clearTimeout(timer);
	}
}

/** The model rows in a list response, or null when the shape is unrecognized.
 *  Accepts the OpenAI `{data:[…]}`, the Ollama-style `{models:[…]}`, or a
 *  bare array. */
function modelRows(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (isRecord(body)) {
		if (Array.isArray(body.data)) return body.data;
		if (Array.isArray(body.models)) return body.models;
	}
	return null;
}

/** Does a /models row advertise image input? Endpoints are inconsistent, so
 *  scan the common modality/capability fields (OpenRouter's
 *  `architecture.input_modalities`, plus `input_modalities` / `modalities` /
 *  `supported_modalities` / `capabilities`) for a value mentioning image or
 *  vision. Absent/unrecognized -> false (text-only); the Keys row exposes a
 *  manual toggle for endpoints that report nothing. */
function detectImage(row: Record<string, unknown>): boolean {
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const candidates = [
		architecture?.input_modalities,
		row.input_modalities,
		row.modalities,
		row.supported_modalities,
		row.capabilities,
	];
	for (const c of candidates) {
		if (Array.isArray(c) && c.some((v) => typeof v === "string" && /image|vision/i.test(v))) return true;
	}
	return false;
}

/** First positive integer among `keys` on a /models row, else undefined.
 *  Endpoints name the token limits inconsistently, so the caller passes an
 *  ordered list of candidate field names. */
function firstPositive(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}

// Field names seen in the wild for each limit (first present wins).
const CONTEXT_KEYS = ["max_input_tokens", "context_length", "context_window", "max_context", "n_ctx", "max_seq_len", "max_position_embeddings"] as const;
const MAX_TOKEN_KEYS = ["max_output_tokens"] as const;

/** Pull models out of a list response (entries are `{id, ...}` objects or bare
 *  strings), each carrying its detected image capability and token limits.
 *  Returns null when the shape is unrecognized - the caller reports an honest
 *  error rather than a misleading empty "no models". */
function extractModels(body: unknown): CustomModel[] | null {
	const rows = modelRows(body);
	if (rows === null) return null;
	const byId = new Map<string, CustomModel>();
	for (const row of rows) {
		if (typeof row === "string") {
			if (row.trim()) byId.set(row, { id: row });
			continue;
		}
		if (isRecord(row) && typeof row.id === "string" && row.id.trim()) {
			const model: CustomModel = { id: row.id };
			if (detectImage(row)) model.image = true;
			const context = firstPositive(row, CONTEXT_KEYS);
			if (context) model.context = context;
			const maxTokens = firstPositive(row, MAX_TOKEN_KEYS);
			if (maxTokens) model.maxTokens = maxTokens;
			byId.set(row.id, model);
		}
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
