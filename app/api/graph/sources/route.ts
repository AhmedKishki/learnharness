import { readOrganizationAction, sourceDirectory, SourceOrganizationInputError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try { return Response.json(sourceDirectory.read()); }
	catch { return Response.json({ error: "Could not read source organization." }, { status: 500 }); }
}

export async function POST(request: Request) {
	try { return Response.json(sourceDirectory.change(await readOrganizationAction(request))); }
	catch (error) {
		const input = error instanceof SourceOrganizationInputError;
		return Response.json({ error: input ? error.message : "Could not save source organization." }, { status: input ? 400 : 500 });
	}
}
