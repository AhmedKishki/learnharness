/**
 * The custom endpoint's connect surface (one provider in the Keys list).
 *   GET  → non-secret config { baseUrl, models } + keyPresent (masked).
 *   POST → connect: validate + normalize the base URL, probe /models (fail
 *          fast), store the key, persist { baseUrl, models }, re-sync the
 *          provider into piModels(). Discovery lives here because connecting
 *          and discovering are one user action.
 *   DELETE → disconnect: drop the stored config + the stored key and unregister
 *          the provider (the mirror image of POST; idempotent).
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

	// Empty key string clears it, absent leaves it stored; only a real key rides the probe.
	const keyProvided = typeof body?.key === "string";
	const key = keyProvided ? (body!.key as string).trim() : undefined;

	// Probe first: a URL that doesn't answer with a model list never persists.
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

/** Disconnect: forget the endpoint AND its key, then unregister the provider.
 *  Deleting the section (rather than blanking baseUrl) keeps settings.json the
 *  same shape as a never-connected install. Idempotent by construction. */
export async function DELETE() {
	const record = readSettingsRecord() ?? { version: 1 };
	const { customProvider: _dropped, ...rest } = record;
	const next = writeSettingsRecord(rest);
	deleteKey(CUSTOM_PROVIDER.envVar);
	syncCustomProvider(next.customProvider);
	return Response.json({ ok: true });
}
