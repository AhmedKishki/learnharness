"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { canMoveFolder, folderIsEmpty, fuzzyScore, placementOf, type OrganizationAction, type SourceDirectory } from "@/src/core";
import type { ChainSort } from "./chain-table";

export type OrganizationChange = (action: OrganizationAction) => Promise<void>;
const DRAG_TYPE = "application/x-learnharness-source";
export function sourceDragProps(kind: "source" | "folder", id: string) {
	return {
		draggable: true,
		onDragStart(event: DragEvent) {
			if ((event.target as HTMLElement).closest("input")) { event.preventDefault(); return; }
			event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind, id }));
			event.dataTransfer.effectAllowed = "move";
		},
	};
}

/** Source/folder names are also searchable, including sources without nodes. */
export function sourceNameMatches(directory: SourceDirectory | undefined, id: string, label: string | null, query: string): boolean {
	if (!query.trim()) return true;
	if (fuzzyScore(query, label ?? "") !== null) return true;
	if (!directory) return false;
	let parent = placementOf(directory.organization, id)?.folderId ?? null;
	const seen = new Set<string>();
	while (parent !== null && !seen.has(parent)) {
		seen.add(parent);
		const folder = directory.organization.folders.find((f) => f.id === parent);
		if (!folder) break;
		if (fuzzyScore(query, folder.name) !== null) return true;
		parent = folder.parentId;
	}
	return false;
}

/** Same Enter/blur commit and Escape cancel interaction as session titles.
 * The in-flight guard prevents Enter followed by blur from double-writing. */
export function EditableSourceName({ name, onSave, onCancel, initiallyEditing = false }: {
	name: string; onSave: (name: string) => Promise<void>; onCancel?: () => void; initiallyEditing?: boolean;
}) {
	const [editing, setEditing] = useState(initiallyEditing);
	const [draft, setDraft] = useState(name);
	const [failure, setFailure] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const submitting = useRef(false);
	const cancelled = useRef(false);
	useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
	const commit = async () => {
		if (cancelled.current || submitting.current) return;
		const value = draft.trim();
		if (!value) { setEditing(false); onCancel?.(); return; }
		if (value === name && !initiallyEditing) { setEditing(false); return; }
		submitting.current = true;
		try { await onSave(value); setEditing(false); setFailure(""); }
		catch (error) { setFailure(error instanceof Error ? error.message : String(error)); input.current?.focus(); }
		finally { submitting.current = false; }
	};
	return <span className="min-w-0 flex-1">
		{editing ? <input ref={input} value={draft} placeholder="Folder name" aria-label="Source or folder name" data-testid="source-name-input"
			className="w-full rounded border bg-background px-1 text-sm outline-none focus:border-ring"
			onChange={(e) => setDraft(e.target.value)} onBlur={() => { void commit(); }}
			onKeyDown={(e) => {
				if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditing(false); setFailure(""); onCancel?.(); }
				if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
			}} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }} />
			: <button type="button" className="block max-w-full truncate text-left text-sm font-medium hover:underline" title="Rename"
				onClick={() => { cancelled.current = false; setDraft(name); setEditing(true); }}>{name}</button>}
		{failure && <span role="alert" className="block text-xs text-red-400">{failure}</span>}
	</span>;
}

interface TreeSource {
	key: string; birth: string | null; label: string | null; nodeIds: string[]; newestCreatedAt: string;
}
export function SourceFolderTree<T extends TreeSource>({ groups, directory, query, sort, renderSource, onAction, expanded,
	onToggleExpanded, selection, selectedFolders, onToggleNodes, onToggleFolder, allSourceNodes, allowEmptySelection = true }: {
	groups: T[]; directory?: SourceDirectory; query: string; sort: ChainSort;
	renderSource: (source: T, depth: number) => ReactNode;
	allSourceNodes?: ReadonlyMap<string, ReadonlySet<string>>;
	allowEmptySelection?: boolean;
	onAction?: OrganizationChange; expanded: ReadonlySet<string>; onToggleExpanded: (id: string) => void;
	selection: ReadonlySet<string>; selectedFolders: ReadonlySet<string>;
	onToggleNodes: (ids: string[], next: boolean) => void; onToggleFolder: (id: string, next: boolean) => void;
}) {
	if (!directory) return <>{groups.map((g) => renderSource(g, 0))}</>;
	const state = directory.organization;
	const ids = new Set(directory.sources.map((s) => s.id));
	const search = query.trim() !== "";
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const parentOf = (g: Pick<T, "birth">) => g.birth === null ? null : placementOf(state, g.birth)?.folderId ?? null;
	const isDescendant = (g: Pick<T, "birth">, folderId: string): boolean => {
		let parent = parentOf(g);
		while (parent !== null) {
			if (parent === folderId) return true;
			parent = state.folders.find((f) => f.id === parent)?.parentId ?? null;
		}
		return false;
	};
	const nodeIds = (folderId: string) => [...new Set(allSourceNodes
		? [...allSourceNodes].filter(([birth]) => isDescendant({ birth }, folderId)).flatMap(([, nodes]) => [...nodes])
		: groups.filter((g) => isDescendant(g, folderId)).flatMap((g) => g.nodeIds))];
	const visibleFolder = (id: string): boolean => !search || groups.some((g) => isDescendant(g, id))
		|| state.folders.some((f) => f.id === id && fuzzyScore(query, f.name) !== null)
		|| state.folders.some((f) => f.parentId === id && visibleFolder(f.id));
	const dropProps = (parentId: string | null) => onAction ? {
		onDragOver(event: DragEvent) { if (Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } },
		onDrop(event: DragEvent) {
			const raw = event.dataTransfer.getData(DRAG_TYPE);
			if (!raw) return;
			event.preventDefault(); event.stopPropagation();
			let item: { kind?: unknown; id?: unknown };
			try { item = JSON.parse(raw); } catch { return; }
			if (!item || typeof item !== "object") return;
			if ((item.kind !== "source" && item.kind !== "folder") || typeof item.id !== "string") return;
			if (item.kind === "folder" && !canMoveFolder(state, item.id, parentId)) return;
			void onAction({ action: "move", kind: item.kind, id: item.id, parentId }).catch(() => {});
		},
	} : {};
	const renderLevel = (parentId: string | null, depth: number): ReactNode => {
		const items = [
			...groups.filter((g) => parentOf(g) === parentId).map((g) => ({ kind: "source" as const, source: g, id: g.key, name: g.label ?? "\uffff", count: g.nodeIds.length, date: g.newestCreatedAt })),
			...state.folders.filter((f) => f.parentId === parentId && visibleFolder(f.id)).map((f) => ({ kind: "folder" as const, folder: f, id: f.id, name: f.name, count: nodeIds(f.id).length, date: f.createdAt })),
		];
		items.sort((a, b) => {
			const byName = collator.compare(a.name, b.name);
			return (sort.col === "name" ? byName : sort.col === "props" ? a.count - b.count : a.date.localeCompare(b.date)) * sort.dir || byName || a.id.localeCompare(b.id);
		});
		return items.map((item) => {
			if (item.kind === "source") return renderSource(item.source, depth);
			const folder = item.folder;
			const open = search || expanded.has(folder.id);
			const members = nodeIds(folder.id);
			const empty = folderIsEmpty(state, folder.id, ids);
			const selectedCount = members.filter((id) => selection.has(id)).length;
			return <div key={folder.id} data-testid={`source-folder-${folder.id}`}>
				<div className="flex items-center gap-1 border-b border-border/60 py-1.5 pr-3" style={{ paddingLeft: 12 + depth * 36 }}
					{...(onAction ? sourceDragProps("folder", folder.id) : {})} {...dropProps(folder.id)}>
					<input type="checkbox" aria-label={`Select contents of ${folder.name}`} data-testid={`folder-checkbox-${folder.id}`}
						className="size-3.5 shrink-0 accent-primary" disabled={empty ? !allowEmptySelection : members.length === 0}
						checked={empty ? selectedFolders.has(folder.id) : members.length > 0 && selectedCount === members.length}
						ref={(el) => { if (el) el.indeterminate = !empty && selectedCount > 0 && selectedCount < members.length; }}
						onChange={(e) => { if (empty) onToggleFolder(folder.id, e.target.checked); else onToggleNodes(members, e.target.checked); }} />
					<button type="button" aria-expanded={open} aria-label={`Expand folder ${folder.name}`} data-testid={`folder-toggle-${folder.id}`}
						onClick={() => onToggleExpanded(folder.id)} className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
						<ChevronRightIcon className={`size-3.5 ${open ? "rotate-90" : ""}`} />
					</button>
					{open ? <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />}
					{onAction ? <EditableSourceName name={folder.name} onSave={(name) => onAction({ action: "rename-folder", id: folder.id, name })} />
						: <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>}
					<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{members.length}</span>
					<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{folder.createdAt.slice(0, 10)}</span>
				</div>
				{open && renderLevel(folder.id, depth + 1)}
			</div>;
		});
	};
	return <>
		{onAction && <div data-testid="source-root-drop" className="border-b border-dashed border-border/60 px-3 py-1 text-[11px] text-muted-foreground" {...dropProps(null)}>Top level</div>}
		{renderLevel(null, 0)}
	</>;
}
