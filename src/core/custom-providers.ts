/** Declarative custom-provider configuration. The envelope/normalization follows
 * Pi coding-agent 1.4.0's model-config/provider-composer (MIT, Mario Zechner).
 * Pi AI owns the shared model/compatibility schemas and the runtime models.
 * Deliberate differences: new provider IDs only, explicit limits/prices,
 * and no OAuth, extensions, overrides, or executable credential commands.
 *
 * Adapted portions: Copyright (c) Mario Zechner. Permission is hereby granted,
 * free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so, subject to
 * the following conditions: The above copyright notice and this permission
 * notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE. */
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { ModelCostSchema, ModelInputLimitsSchema, ModelInputModalitySchema, ModelPromptCacheSchema, ThinkingLevelMapSchema } from "@earendil-works/pi-ai/providers/model-schema";

const Headers = Type.Record(Type.String(), Type.String());
const Sampling = Type.Record(Type.String(), Type.Unknown());
const ModelSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(ModelInputModalitySchema)),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: ModelCostSchema,
	promptCache: Type.Optional(ModelPromptCacheSchema),
	contextWindow: Type.Number({ exclusiveMinimum: 0 }),
	maxTokens: Type.Number({ exclusiveMinimum: 0 }),
	samplingParams: Type.Optional(Sampling),
	samplingParamsByThinkingLevel: Type.Optional(Type.Object(Object.fromEntries(
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, Type.Optional(Sampling)]),
	))),
	headers: Type.Optional(Headers),
	compat: Type.Optional(ProviderCompatSchema),
}, { additionalProperties: false });
const ProviderSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Headers),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Array(ModelSchema),
}, { additionalProperties: false });
const ConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	providers: Type.Record(Type.String(), ProviderSchema),
}, { additionalProperties: false });
const validator = Compile(ConfigSchema);
export type CustomProviderDefinition = Static<typeof ProviderSchema>;
export interface CustomProviderConfig {
	id: string;
	definition: CustomProviderDefinition;
	models: Model<Api>[];
}

/** Error messages describe fields only: never include file contents or values. */
export class CustomProviderConfigError extends Error {}
function invalid(message: string): never { throw new CustomProviderConfigError(message); }

/** Pi-style values, but never execute commands. Escapes are processed once;
 * a literal/variable's resolved value beginning with ! is still just data. */
export function resolveCustomValue(value: string, lookup: (name: string) => string | undefined): string | undefined {
	if (value.startsWith("!")) invalid("Credential commands are not supported in models.json.");
	let missing = false;
	const resolved = value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, plain: string | undefined) => {
		if (match === "$$") return "$";
		if (match === "$!") return "!";
		const found = lookup(braced ?? plain!);
		if (found === undefined) missing = true;
		return found ?? "";
	});
	return missing ? undefined : resolved;
}

function endpoint(value: string | undefined): string {
	if (!value) invalid("Each custom model needs an api and baseUrl, at provider or model level.");
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
	} catch { invalid("Custom baseUrl must be an HTTP(S) URL without embedded credentials or a fragment."); }
	return value;
}
function compat(base: Model<Api>["compat"], override: Model<Api>["compat"]): Model<Api>["compat"] {
	if (!base && !override) return undefined;
	const merged = { ...base, ...override } as Record<string, unknown>;
	for (const name of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"]) {
		const a = (base as Record<string, unknown> | undefined)?.[name];
		const b = (override as Record<string, unknown> | undefined)?.[name];
		if (a || b) merged[name] = { ...(a as object | undefined), ...(b as object | undefined) };
	}
	return merged as Model<Api>["compat"];
}

export function parseCustomProviders(text: string, reserved: ReadonlySet<string>, supportedApis: ReadonlySet<string>): CustomProviderConfig[] {
	let raw: unknown;
	// Match Pi's line comments/trailing commas without touching JSON strings.
	const json = text.replace(/^\uFEFF/, "")
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match[0] === '"' ? match : "")
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
	try { raw = JSON.parse(json); }
	catch { return invalid("models.json is not valid JSON."); }
	if (!validator.Check(raw)) invalid("Invalid models.json structure: check provider/model fields and explicit contextWindow, maxTokens and cost.");
	return Object.entries(raw.providers).map(([id, definition]) => {
		if (!id.trim() || id.includes(":")) invalid("Custom provider IDs must be nonempty and must not contain a colon.");
		if (reserved.has(id)) invalid("Custom provider IDs must not replace built-in or subscription providers.");
		for (const value of [definition.apiKey, ...Object.values(definition.headers ?? {}), ...definition.models.flatMap((m) => Object.values(m.headers ?? {}))]) {
			if (value !== undefined) resolveCustomValue(value, () => "validation");
		}
		const ids = new Set<string>();
		const models = definition.models.map((model): Model<Api> => {
			if (ids.has(model.id)) invalid("Duplicate model IDs are not supported within a custom provider.");
			ids.add(model.id);
			const api = model.api ?? definition.api;
			if (!api || !supportedApis.has(api)) invalid("A custom model specifies a missing or unsupported Pi API.");
			const rates = [model.cost, ...(model.cost.tiers ?? [])];
			if (![model.contextWindow, model.maxTokens].every(Number.isFinite) || rates.some((rate) => Object.values(rate).some((n) => typeof n === "number" && (!Number.isFinite(n) || n < 0)))) invalid("Custom model limits and costs must be finite; limits must be positive and costs nonnegative.");
			return {
				...model,
				provider: id,
				api,
				baseUrl: endpoint(model.baseUrl ?? definition.baseUrl),
				name: model.name ?? model.id,
				reasoning: model.reasoning ?? false,
				input: model.input ?? ["text"],
				compat: compat(definition.compat, model.compat),
			};
		});
		return { id, definition, models };
	});
}
