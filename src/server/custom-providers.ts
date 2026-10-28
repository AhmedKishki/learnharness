/** Configuration composition only. Pi's Models collection is the one runtime
 * registry. A failed reload removes custom routes, never alters built-ins. */
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createCustomProvider, customProviderApis, customProviderAuth } from "../agent/custom-providers.ts";
import { configureProviderSource } from "../agent/models.ts";
import { parseCustomProviders, resolveCustomValue, CustomProviderConfigError, type CustomProviderConfig } from "../core/custom-providers.ts";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { readCustomProvidersFile } from "../store/custom-providers.ts";

const reserved = new Set([...builtinProviders().map((p) => p.id), "chatgpt", CLAUDE_CODE_PROVIDER, ...NATIVE_SUBSCRIPTIONS.map((p) => p.logicalId)]);

/** Instance-local so every Next server module graph registers into its own Pi
 * collection. No process-global registry or personal Pi config is consulted. */
export class CustomProviderSource {
	private text?: string;
	private fingerprint?: string;
	private configs: CustomProviderConfig[] = [];
	private registered = new Set<string>();
	private ready = new Map<string, boolean>();
	private error?: string;

	constructor(
		private readonly read: typeof readCustomProvidersFile,
		private readonly key: (name: string) => string | undefined,
	) {}

	sync(models: MutableModels): void {
		try {
			const record = this.read();
			if (record.error) throw new CustomProviderConfigError(record.error);
			if (record.text !== this.text || this.error) {
				this.configs = parseCustomProviders(record.text!, reserved, customProviderApis);
				this.text = record.text;
				this.fingerprint = undefined;
			}
			// Resolve only referenced variables through the app's existing key seam.
			// Changes in credentials/headers trigger a new immutable provider snapshot
			// even when the configuration file itself has not changed.
			const values = new Map<string, string | undefined>();
			for (const config of this.configs) {
				for (const template of [config.definition.apiKey, ...Object.values(config.definition.headers ?? {}), ...config.models.flatMap((m) => Object.values(m.headers ?? {}))]) {
					if (template !== undefined) resolveCustomValue(template, (name) => {
						const value = this.key(name);
						values.set(name, value);
						return value;
					});
				}
			}
			const fingerprint = JSON.stringify([...values]);
			if (this.fingerprint === fingerprint) return;
			const lookup = (name: string) => values.get(name);
			const providers = this.configs.map((config) => createCustomProvider(config, lookup));
			const ready = new Map(this.configs.map((config) => [config.id, customProviderAuth(config, lookup) !== undefined]));
			// Everything validates/builds before the synchronous publication begins.
			for (const id of this.registered) models.deleteProvider(id);
			this.registered = new Set(providers.map((p) => p.id));
			for (const provider of providers) models.setProvider(provider);
			this.ready = ready;
			this.fingerprint = fingerprint;
			this.error = undefined;
		} catch (error) {
			for (const id of this.registered) models.deleteProvider(id);
			this.registered.clear();
			this.ready.clear();
			this.fingerprint = undefined;
			this.error = error instanceof CustomProviderConfigError ? error.message : "Unable to configure custom providers from models.json.";
		}
	}

	configured(provider: string): boolean | undefined { return this.ready.get(provider); }
	providers(): { id: string; envVar: string; keyPresent: boolean }[] {
		return [...this.ready].map(([id, keyPresent]) => ({ id, envVar: "", keyPresent }));
	}
	getError(): string | undefined { return this.error; }
}

let source: CustomProviderSource | undefined;
export function installCustomProviderSource(key: (name: string) => string | undefined): void {
	const next = new CustomProviderSource(readCustomProvidersFile, key);
	configureProviderSource({
		sync: (models) => next.sync(models),
		isCustom: (id) => next.configured(id) !== undefined,
	});
	source = next;
}
/** Call piModels() before these reads to synchronize the snapshot. */
export function customProviderRows() { return source?.providers() ?? []; }
export function customProviderConfigured(provider: string): boolean | undefined { return source?.configured(provider); }
export function customProvidersError(): string | undefined { return source?.getError(); }
