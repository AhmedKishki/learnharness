"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLAUDE_CODE_MINIMUM_VERSION, type ClaudeCodeStatus } from "@/src/core";
import { ConnectionRow } from "./connection-controls.tsx";

export function claudeCodeStatusLabel(status: ClaudeCodeStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found";
		case "meets-minimum": return `Version ${status.version} · meets minimum`;
		case "update-required": return `Version ${status.version} · update required`;
		default: return "Version could not be checked";
	}
}

export function ClaudeCodeInstallationStatus() {
	const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
	const [busy, setBusy] = useState(true);
	const request = useRef<AbortController | null>(null);
	const refresh = useCallback(async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/claude-code", { cache: "no-store", signal: controller.signal, headers: { "x-learnharness-claude-code": "1" } });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as ClaudeCodeStatus;
			if (!["not-found", "meets-minimum", "update-required", "version-unchecked"].includes(value.state)
				|| value.minimumVersion !== CLAUDE_CODE_MINIMUM_VERSION
				|| (value.version !== null && (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)))) throw new Error("invalid status");
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
		return () => request.current?.abort();
	}, [refresh]);
	return <div className="space-y-2" data-testid="claude-code-installation">
		<ConnectionRow label="Claude Code" labelClassName="font-prose text-(length:--lh-prose-size) text-foreground" action="Check again" actionVariant="outline" disabled={busy} onAction={() => void refresh()} actionTestid="claude-code-check-again">
			<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : claudeCodeStatusLabel(status)}</span>
		</ConnectionRow>
		<p className="text-xs leading-relaxed text-muted-foreground">Install and authenticate in Claude Code outside LearnHarness. Authentication is not checked. Your Claude Code configuration determines billing.</p>
		<p className="text-xs leading-relaxed text-muted-foreground">Minimum version: {CLAUDE_CODE_MINIMUM_VERSION}. Meeting this minimum does not guarantee MCP compatibility, model access, or available quota. <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Claude Code setup ↗</a></p>
	</div>;
}
