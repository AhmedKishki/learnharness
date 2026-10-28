import { claudeCodeInstallationStatus } from "@/src/server";

/** Installation/version only; never reads auth status or makes a model request. */
export async function GET() {
	return Response.json(await claudeCodeInstallationStatus(), { headers: { "Cache-Control": "no-store" } });
}
