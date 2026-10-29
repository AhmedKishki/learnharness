/**
 * The custom endpoint's connect surface (one provider in the Keys list).
 *   GET    → non-secret config { baseUrl, models, overrides, manualModels } +
 *            keyPresent (masked).
 *   POST   → connect: validate + normalize the base URL, probe /models, store
 *            the key, persist { baseUrl, models, overrides, manualModels },
 *            re-sync the provider into piModels(). Discovery lives here because
 *            connecting and discovering are one user action. A failed probe is
 *            fatal UNLESS the user typed model IDs: an endpoint that serves chat
 *            but no model list is configured from those ids alone. A failed
 *            probe for the endpoint already stored keeps its last snapshot, so
 *            a blip cannot prune the stored pins. A 401/403 always fails: a
 *            rejected key is not a missing model list. Stored user pins survive
 *            a reconnect, pruned to the ids the connect ends up offering.
 *   PATCH  → store per-model pins only. No probe: pins must be editable with
 *            the local server switched off (the case they exist for).
 *   DELETE → disconnect: drop the stored config + the stored key and unregister
 *            the provider (the mirror image of POST; idempotent).
 */
import {
	deleteKey,
	discoverModels,
	effectiveSettings,
	keyValue,
	mergeManualModels,
	parseCustomModelOverridesBody,
	readSettingsRecord,
	saveKey,
	syncCustomProvider,
	writeSettingsRecord,
} from "@/src/server";
import { CUSTOM_PROVIDER, normalizeBaseUrl, parseModelIds, sanitizeCustomModelOverrides } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	const cp = effectiveSettings().customProvider;
	return Response.json({
		baseUrl: cp.baseUrl,
		models: cp.models,
		overrides: cp.overrides,
		manualModels: cp.manualModels,
		keyPresent: keyValue(CUSTOM_PROVIDER.envVar) !== undefined,
	});
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { baseUrl?: unknown; key?: unknown; manualModels?: unknown } | null;
	const base = normalizeBaseUrl(typeof body?.baseUrl === "string" ? body.baseUrl : "");
	if (!base) return Response.json({ error: "Base URL must be a valid http(s) URL" }, { status: 400 });

	// Empty key string clears it, absent leaves it stored; only a real key rides the probe.
	const keyProvided = typeof body?.key === "string";
	const key = keyProvided ? (body!.key as string).trim() : undefined;

	const manualModels = parseModelIds(body?.manualModels);
	const record = readSettingsRecord() ?? { version: 1 };
	const found = await discoverModels(base, key ? key : undefined);
	// A rejected key is not a missing model list: never let typed ids turn an
	// auth failure into a stored "connected" endpoint.
	if (!found.ok && (found.status === 401 || found.status === 403)) {
		return Response.json({ error: found.error }, { status: 502 });
	}
	if (!found.ok && !manualModels.length) {
		return Response.json({ error: `${found.error}. If this endpoint has no /models list, add model IDs manually.` }, { status: 502 });
	}
	// A failed probe says nothing about what the endpoint offers: keep the last
	// snapshot of the SAME endpoint, so a transient failure cannot shrink the
	// model list and prune its pins. A different base URL starts clean.
	const discovered = found.ok
		? found.models
		: record.customProvider?.baseUrl === base
			? (record.customProvider?.models ?? [])
			: [];
	const models = mergeManualModels(discovered, manualModels);

	if (keyProvided) {
		if (key) {
			const saved = saveKey(CUSTOM_PROVIDER.envVar, key);
			if (!saved.ok) return Response.json({ error: saved.error }, { status: 400 });
		} else {
			deleteKey(CUSTOM_PROVIDER.envVar);
		}
	}

	// User pins are never rewritten by discovery — only pruned to the ids this
	// connect offers (discovered ∪ typed).
	const overrides = sanitizeCustomModelOverrides(
		record.customProvider?.overrides,
		models.map((m) => m.id),
	);
	const next = writeSettingsRecord({
		...record,
		customProvider: { baseUrl: base, models, overrides, ...(manualModels.length ? { manualModels } : {}) },
	});
	syncCustomProvider(next.customProvider);
	return Response.json({ ok: true, models: next.customProvider?.models ?? [] });
}

/** Store the per-model pins (replace-whole). Pruned against the STORED model
 *  list, never a probe — an offline endpoint keeps its pins editable. */
export async function PATCH(request: Request) {
	const parsed = parseCustomModelOverridesBody(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	const cp = effectiveSettings().customProvider;
	if (!cp.baseUrl) return Response.json({ error: "No custom endpoint configured" }, { status: 409 });

	const overrides = sanitizeCustomModelOverrides(
		parsed.settings,
		cp.models.map((m) => m.id),
	);
	const record = readSettingsRecord() ?? { version: 1 };
	const next = writeSettingsRecord({
		...record,
		customProvider: { baseUrl: cp.baseUrl, models: cp.models, overrides, ...(cp.manualModels.length ? { manualModels: cp.manualModels } : {}) },
	});
	syncCustomProvider(next.customProvider);
	return Response.json({ ok: true, overrides: next.customProvider?.overrides ?? {} });
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
