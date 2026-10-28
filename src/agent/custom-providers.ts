/** Native Pi providers assembled from validated configuration. No IO or registry
 * here: the server supplies key lookup, and Pi owns model dispatch/streaming. */
import { createProvider, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { lazyApi } from "@earendil-works/pi-ai/api/lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { resolveCustomValue, type CustomProviderConfig } from "../core/custom-providers.ts";

const apis: Record<string, ProviderStreams> = {
	"anthropic-messages": anthropicMessagesApi(),
	"openai-completions": openAICompletionsApi(),
	"openai-responses": openAIResponsesApi(),
	"openai-codex-responses": openAICodexResponsesApi(),
	"azure-openai-responses": azureOpenAIResponsesApi(),
	"google-generative-ai": googleGenerativeAIApi(),
	"google-vertex": googleVertexApi(),
	// Pi's Bedrock wrapper intentionally hides its Node-only import from
	// bundlers. Give this server's standalone tracer a literal public import;
	// Pi still owns both lazy forwarding and the unchanged native transport.
	"bedrock-converse-stream": lazyApi(() => import("@earendil-works/pi-ai/api/bedrock-converse-stream")),
	"mistral-conversations": mistralConversationsApi(),
	"pi-messages": piMessagesApi(),
};
export const customProviderApis: ReadonlySet<string> = new Set(Object.keys(apis));

function resolveHeaders(headers: Record<string, string> | undefined, lookup: (name: string) => string | undefined): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const resolved = resolveCustomValue(value, lookup);
		if (resolved === undefined) return undefined;
		result[name] = resolved;
	}
	return result;
}
export function customProviderAuth(config: CustomProviderConfig, lookup: (name: string) => string | undefined) {
	const key = config.definition.apiKey === undefined ? undefined : resolveCustomValue(config.definition.apiKey, lookup);
	const headers = resolveHeaders(config.definition.headers, lookup);
	if (!key || !headers) return undefined;
	// A model header is part of that model's request configuration. Unresolved
	// references must not silently disappear from a request.
	for (const model of config.models) if (!resolveHeaders(model.headers, lookup)) return undefined;
	if (config.definition.authHeader) {
		for (const name of Object.keys(headers)) if (name.toLowerCase() === "authorization") delete headers[name];
		headers.Authorization = `Bearer ${key}`;
	}
	return { apiKey: key, headers };
}

export function createCustomProvider(config: CustomProviderConfig, lookup: (name: string) => string | undefined): Provider {
	const auth = customProviderAuth(config, lookup);
	return createProvider({
		id: config.id,
		name: config.definition.name ?? config.id,
		baseUrl: config.definition.baseUrl,
		models: config.models.map((model) => ({ ...model, headers: resolveHeaders(model.headers, lookup) })),
		auth: { apiKey: {
			name: "API key",
			check: async () => auth ? { type: "api_key", source: "custom provider configuration" } : undefined,
			resolve: async () => auth ? { auth, source: "custom provider configuration" } : undefined,
		} },
		// Direct native implementations: no copied stream or request conversion.
		api: apis,
	});
}
