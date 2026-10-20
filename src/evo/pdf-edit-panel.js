/**
 * ZotFlow Evo: the PDF editing menu, under the note strip's buttons (PDFs
 * only). Tools are chosen first — each shows what it needs over the pages
 * or below it — and run together with "Process". The work on the file is
 * the plugin's (it rewrites and uploads the PDF); this only collects what
 * to do:
 *
 * - Split pages: where each page is cut in two (pdf-edit-overlay.js).
 * - Straighten: measured here, page by page (deskew.mjs); only pages with
 *   a clear tilt within ±5° are turned.
 * - Remove outline: the PDF's bookmarks.
 * - Extract pages: a range (by the PDF's labels or by page numbers, or
 *   picked on the pages), the collection the new PDF goes to, and whether
 *   to open it.
 *
 * Whenever the PDF is rewritten, its page filter is written into it too
 * (Info dictionary), and "Save page filter in PDF" does only that.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cx from "classnames";
import { ObsidianBridge } from "../obsidian-adapter";
import { PdfEditOverlay } from "./pdf-edit-overlay";
import { measurePages } from "./deskew.mjs";
import { formatPageRange, parsePageRange } from "./page-range.mjs";
import { isNeutralPdfFilter, pdfFilterOf } from "./page-filter.mjs";

const TOOLS = [
	{ id: "split", label: "Split pages", title: "Cut every page in two where the line is" },
	{ id: "straighten", label: "Straighten", title: "Turn tilted scanned pages level (automatic)" },
	{ id: "removeOutline", label: "Remove outline", title: "Remove the PDF's bookmarks" },
	{ id: "extract", label: "Extract pages", title: "Copy pages into a new PDF in a collection" },
];

/** Tell the plugin what to do with the file. */
function requestEdit(request) {
	try {
		ObsidianBridge?.handleEvent?.({ type: "pdfEditRequest", request });
		return true;
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not ask for the PDF to be edited:", e);
		return false;
	}
}

/** The collections of the PDF's library ({ key, path }), from the plugin. */
function useCollections() {
	const [list, setList] = useState(null);
	useEffect(() => {
		let gone = false;
		Promise.resolve(ObsidianBridge?.evoListCollections?.())
			.then(result => !gone && setList(Array.isArray(result) ? result : []))
			.catch(() => !gone && setList([]));
		return () => {
			gone = true;
		};
	}, []);
	return list;
}

function CollectionPicker({ value, onChange }) {
	const collections = useCollections();
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const chosen = collections?.find(c => c.key === value);
	const matches = useMemo(() => {
		if (!collections) return [];
		const q = query.trim().toLowerCase();
		return collections.filter(c => !q || c.path.toLowerCase().includes(q)).slice(0, 8);
	}, [collections, query]);
	return (
		<div className="zf-evo-picker">
			<input
				type="search"
				className="zf-evo-picker-input"
				placeholder={chosen ? chosen.path : "Collection (none: the library)"}
				value={query}
				onFocus={() => setOpen(true)}
				onBlur={() => setTimeout(() => setOpen(false), 150)}
				onChange={event => {
					setQuery(event.target.value);
					setOpen(true);
				}}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Enter" && matches[0]) {
						onChange(matches[0].key);
						setQuery("");
						setOpen(false);
					}
					else if (event.key === "Escape") setOpen(false);
				}}
			/>
			{chosen && (
				<button type="button" className="zf-evo-picker-clear" title="No collection" onClick={() => onChange(null)}>×</button>
			)}
			{open && matches.length > 0 && (
				<div className="zf-evo-picker-list" role="listbox">
					{matches.map(c => (
						<div
							key={c.key}
							role="option"
							aria-selected={c.key === value}
							className={cx("zf-evo-picker-item", { "is-chosen": c.key === value })}
							onMouseDown={(event) => {
								event.preventDefault();
								onChange(c.key);
								setQuery("");
								setOpen(false);
							}}
						>
							{c.path}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default function PdfEditPanel({ view, pageLabels, filter, onClose }) {
	const [tools, setTools] = useState(() => new Set());
	const [range, setRange] = useState("");
	const [useLabels, setUseLabels] = useState(true);
	const [collection, setCollection] = useState(null);
	const [openAfter, setOpenAfter] = useState(true);
	const [saveFilter, setSaveFilter] = useState(false);
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const overlay = useRef(null);
	const count = view?._iframeWindow?.PDFViewerApplication?.pagesCount || pageLabels?.length || 0;
	const labels = pageLabels || [];
	const hasLabels = labels.some((label, i) => String(label) !== String(i + 1));
	const filterSet = !isNeutralPdfFilter(filter);

	// Read by the overlay's callback, which outlives renders.
	const latest = useRef({});
	latest.current = { labels, useLabels: useLabels && hasLabels };

	// The overlay lives while the panel is open.
	useEffect(() => {
		if (!view?._iframeWindow) return undefined;
		const o = new PdfEditOverlay(view, () => {
			if (o.extractOn) setRange(formatPageRange(o.getPicked(), latest.current));
		});
		overlay.current = o;
		return () => {
			o.destroy();
			overlay.current = null;
		};
	}, [view]);

	useEffect(() => {
		overlay.current?.setSplit(tools.has("split"));
		overlay.current?.setExtract(tools.has("extract"));
	}, [tools]);

	const parsed = useMemo(
		() => parsePageRange(range, { count, labels, useLabels: useLabels && hasLabels }),
		[range, count, labels, useLabels, hasLabels],
	);
	// The range typed shows on the pages.
	useEffect(() => {
		if (Array.isArray(parsed)) overlay.current?.setPicked(parsed);
	}, [parsed]);

	const toggle = useCallback((id) => {
		setTools((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	}, []);

	const switchLabels = (on) => {
		// The same pages, written the other way.
		const pages = Array.isArray(parsed) ? parsed : [];
		setUseLabels(on);
		setRange(formatPageRange(pages, { labels, useLabels: on && hasLabels }));
	};

	const extractPages = tools.has("extract") && Array.isArray(parsed) ? parsed : [];
	const extractInvalid = tools.has("extract") && (!Array.isArray(parsed) || !extractPages.length);
	const nothing = !tools.size && !(saveFilter && filterSet);

	async function process() {
		if (busy || nothing || extractInvalid) return;
		setBusy(true);
		try {
			const request = {};
			if (tools.has("split")) request.split = overlay.current?.getSplit() ?? { shared: 0.5, pages: {} };
			if (tools.has("removeOutline")) request.removeOutline = true;
			if (tools.has("extract")) request.extract = { pages: extractPages, collectionKey: collection, open: openAfter };
			if (tools.has("straighten")) {
				const app = view._iframeWindow.PDFViewerApplication;
				const doc = view._iframeWindow.document;
				const all = Array.from({ length: count }, (_, i) => i);
				setStatus(`Measuring page 1 of ${count}…`);
				request.straighten = await measurePages(app.pdfDocument, all, {
					createCanvas: (w, h) => Object.assign(doc.createElement("canvas"), { width: w, height: h }),
					onProgress: (done, total) => setStatus(`Measuring page ${Math.min(done + 1, total)} of ${total}…`),
				});
				const turned = Object.keys(request.straighten).length;
				if (!turned && Object.keys(request).length === 1 && !(saveFilter && filterSet)) {
					setStatus("No page is tilted enough to straighten.");
					setBusy(false);
					return;
				}
			}
			// Whenever the file is rewritten, the page filter goes with it.
			if (filterSet) request.pageFilter = pdfFilterOf(filter);
			if (saveFilter && filterSet) request.saveFilter = true;
			setStatus("");
			if (requestEdit(request)) onClose(true);
		}
		catch (e) {
			console.error("[ZotFlow Evo] PDF editing failed here:", e);
			setStatus("Could not prepare the changes.");
		}
		setBusy(false);
	}

	return (
		<div className="zf-evo-head-panel zf-evo-edit-panel" onKeyDown={event => event.stopPropagation()}>
			<div className="zf-evo-edit-tools">
				{TOOLS.map(tool => (
					<button
						key={tool.id}
						type="button"
						className={cx("zf-evo-chip", { "is-on": tools.has(tool.id) })}
						aria-pressed={tools.has(tool.id)}
						title={tool.title}
						data-edit={tool.id}
						onClick={() => toggle(tool.id)}
					>
						{tool.label}
					</button>
				))}
				{filterSet && (
					<button
						type="button"
						className={cx("zf-evo-chip", { "is-on": saveFilter })}
						aria-pressed={saveFilter}
						title="Write this PDF's page filter into the file (also done with any other change)"
						data-edit="saveFilter"
						onClick={() => setSaveFilter(on => !on)}
					>
						Save page filter in PDF
					</button>
				)}
			</div>
			{tools.has("split") && (
				<div className="zf-evo-edit-hint">
					Drag the red line. Shift+drag sets one page's line alone (blue); Shift+double-click puts it back.
				</div>
			)}
			{tools.has("extract") && (
				<div className="zf-evo-edit-extract">
					<div className="zf-evo-edit-row">
						<input
							type="text"
							className={cx("zf-evo-edit-range", { "is-invalid": range && !Array.isArray(parsed) })}
							placeholder={hasLabels && useLabels ? "Pages, e.g. iv-xii, 3" : "Pages, e.g. 3-7, 12"}
							value={range}
							data-edit-field="range"
							onChange={event => setRange(event.target.value)}
						/>
						{hasLabels && (
							<span className="zf-evo-segmented" role="group" aria-label="Page numbers">
								<button type="button" className={cx({ "is-on": useLabels })} aria-pressed={useLabels} onClick={() => switchLabels(true)} title="By the PDF's page labels">Labels</button>
								<button type="button" className={cx({ "is-on": !useLabels })} aria-pressed={!useLabels} onClick={() => switchLabels(false)} title="By page numbers in the file">Pages</button>
							</span>
						)}
					</div>
					<div className="zf-evo-edit-hint">Shift+click a page, then another: a range. Ctrl+click: one page in or out.</div>
					<CollectionPicker value={collection} onChange={setCollection}/>
					<label className="zf-evo-edit-check">
						<input type="checkbox" checked={openAfter} onChange={event => setOpenAfter(event.target.checked)}/>
						Open the new PDF
					</label>
				</div>
			)}
			{status && <div className="zf-evo-edit-status">{status}</div>}
			<div className="zf-evo-panel-buttons">
				<button type="button" className="zf-evo-panel-button" onClick={() => onClose(false)} disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					className="zf-evo-panel-button is-primary"
					data-edit="process"
					disabled={busy || nothing || extractInvalid}
					onClick={process}
				>
					Process
				</button>
			</div>
		</div>
	);
}
