/**
 * The custom OpenAI-compatible endpoint's connect surface (custom-endpoint
 * wave). It is ONE provider in the Keys list, connected exactly like the
 * built-ins are connected by a key — the only extra input is a base URL.
 *
 *   GET  → the resolved non-secret config { baseUrl, models } + whether a key
 *          is present (masked status only; the key is a secret in the auth
 *          store and never enters settings.json).
 *   POST → connect. Body { baseUrl, key? }: validate + normalize the base URL,
 *          PROBE the endpoint's /models (fail fast — a broken URL never
 *          persists), then store the key (empty string clears it, absent
 *          leaves it), persist { baseUrl, models } to the settings record, and
 *          re-register the provider into piModels() with no restart.
 *
 * Discovery lives here (not a separate route) because connecting and discovering
 * are one user action: paste URL + key, get a working provider.
 */
import {
	deleteKey,
	discoverModels,
	effectiveSettings,
	keyValue,
	readSettingsRecord,
	saveKey,
	syncCustomProvider,
	writeSettingsRecord,
} from "@/src/server";
import { CUSTOM_PROVIDER, normalizeBaseUrl } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	const cp = effectiveSettings().customProvider;
	return Response.json({
		baseUrl: cp.baseUrl,
		models: cp.models,
		keyPresent: keyValue(CUSTOM_PROVIDER.envVar) !== undefined,
	});
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { baseUrl?: unknown; key?: unknown } | null;
	const base = normalizeBaseUrl(typeof body?.baseUrl === "string" ? body.baseUrl : "");
	if (!base) return Response.json({ error: "Base URL must be a valid http(s) URL" }, { status: 400 });

	// A provided key is trimmed; an empty string means "clear it", an absent
	// field means "leave whatever is stored". Only a real key rides the probe.
	const keyProvided = typeof body?.key === "string";
	const key = keyProvided ? (body!.key as string).trim() : undefined;

	// Probe first: a URL that doesn't answer with a model list never persists,
	// so a typo can't leave a half-configured provider behind.
	const found = await discoverModels(base, key ? key : undefined);
	if (!found.ok) return Response.json({ error: found.error }, { status: 502 });

	if (keyProvided) {
		if (key) {
			const saved = saveKey(CUSTOM_PROVIDER.envVar, key);
			if (!saved.ok) return Response.json({ error: saved.error }, { status: 400 });
		} else {
			deleteKey(CUSTOM_PROVIDER.envVar);
		}
	}

	const record = readSettingsRecord() ?? { version: 1 };
	const next = writeSettingsRecord({ ...record, customProvider: { baseUrl: base, models: found.models } });
	syncCustomProvider(next.customProvider);
	return Response.json({ ok: true, models: next.customProvider?.models ?? [] });
}
