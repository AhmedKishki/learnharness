import { inspectClaudeInstallation } from "../agent/claude-code/installation.ts";
import { initAuthEnv } from "./keys.ts";

/** The Settings status seam: initialize provenance before any child env is copied. */
export async function claudeCodeInstallationStatus() {
	initAuthEnv();
	return inspectClaudeInstallation();
}
