/** Read-only adapter. Configuration editing/UI is deliberately a later phase. */
import fs from "node:fs";
import { CUSTOM_MODELS_FILE } from "../../config.ts";

export function readCustomProvidersFile(): { text?: string; error?: string } {
	try { return { text: fs.readFileSync(CUSTOM_MODELS_FILE, "utf8") }; }
	catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { text: '{"providers":{}}' }
			: { error: "Unable to read models.json." };
	}
}
