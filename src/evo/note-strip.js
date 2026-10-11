/**
 * ZotFlow Evo — the note strip: the comments of a PDF, beside the pages.
 *
 * Rendered by the reader's React tree (one line in reader-ui.js) into the
 * strip's own documents, which `strip-host.js` creates inside the PDF view:
 * a pinned head (title line, buttons, colour filters) and the strip itself.
 * What is listed, and in what order, is decided in `strip-layout.mjs`.
 *
 * The strip shows what Zotero stores:
 *  - comments — of a highlight, underline, image or ink annotation, and note
 *    annotations — each with two bars in the annotation's colour;
 *  - with "highlights" switched on, what was marked on the page as well: the
 *    full text of each highlight, with one bar;
 *  - the PDF's outline, as plain headings between them.
 *
 * It has two modes. As a list (the default) it is a column of its own, like
 * the reader's annotations sidebar. Anchored, every entry sits beside its
 * place on the page and the strip scrolls with the pages.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import cx from "classnames";
import { ObsidianBridge } from "../obsidian-adapter";
import { ANNOTATION_COLORS } from "../common/defines";
import { NOTE_STRIP_STATE, applyNoteStrip, reportNoteStrip } from "../obsidian-evo";
import { EvoStripHost } from "./strip-host";
import {
	buildEntries, estimateHeight, flattenOutline, layoutCards, pageStartSlot, usedColors, LINE_HEIGHT,
} from "./strip-layout.mjs";

/** Entries this far above and below the visible part are rendered too (anchored mode). */
const OVERSCAN = 1500;

/** The set of rendered entries is reconsidered every this many pixels of scrolling. */
const SCROLL_STEP = 400;

/** Wait for the click that selected an annotation to finish before taking the focus. */
const FOCUS_DELAY = 60;

const PALETTE = ANNOTATION_COLORS.map(([, color]) => color.toLowerCase());
const COLOR_NAMES = new Map(ANNOTATION_COLORS.map(([name, color]) => [color.toLowerCase(), name.replace("general-", "")]));
const DEFAULT_NOTE_COLOR = PALETTE[0];

/* ------------------------------------------------------------------ *
 * Editing and showing a comment
 * ------------------------------------------------------------------ */

/**
 * A plain text box with the part of the markdown editor's interface the
 * strip uses. Stands in if Obsidian's editor cannot be created in the strip
 * document, so comments can always be written.
 */
function createPlainEditor(mount, options) {
	const doc = mount.ownerDocument;
	const area = doc.createElement("textarea");
	area.className = "zf-evo-plain-editor";
	area.rows = 1;
	area.value = options.value || "";
	const fit = () => {
		area.style.height = "auto";
		area.style.height = area.scrollHeight + "px";
	};
	area.addEventListener("input", () => {
		fit();
		options.onChange({ state: { doc: { toString: () => area.value } } });
	});
	area.addEventListener("keydown", (event) => {
		if (event.key === "Escape") options.onEscape();
	});
	mount.appendChild(area);
	doc.defaultView.requestAnimationFrame(fit);
	return {
		get value() {
			return area.value;
		},
		set(text, focus) {
			if (area.value !== text) {
				area.value = text;
				fit();
			}
			if (focus) area.focus();
		},
		activeCM: {
			focus() {
				area.focus({ preventScroll: true });
				area.setSelectionRange(area.value.length, area.value.length);
			},
		},
		onunload() {
			area.remove();
		},
	};
}

/**
 * The element Obsidian's editor or renderer is given to work in. Obsidian
 * uses its DOM helpers on it; they exist on elements of a document that
 * loaded its enhance.js. The strip's document did (strip-host.js); if that
 * failed, an element made by the reader's document still has them and is
 * adopted by the strip.
 */
function createMount(holder, className) {
	let mount = holder.ownerDocument.createElement("div");
	if (typeof mount.createDiv !== "function") {
		mount = window.document.createElement("div");
	}
	mount.className = className;
	holder.appendChild(mount);
	return mount;
}

function focusEditor(editor, win) {
	if (!editor) return;
	try {
		win.focus();
		const cm = editor.activeCM;
		// Writing continues the comment: the cursor goes to its end.
		if (cm?.dispatch && cm.state?.doc) {
			cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		}
		if (cm?.focus) cm.focus();
		else editor.set(editor.value ?? "", true);
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not focus the comment editor:", e);
	}
}

function StripEditor({ id, text, focusToken, host, onChange, onEscape }) {
	const holderRef = useRef();
	const editorRef = useRef(null);
	const textRef = useRef(text || "");
	const onChangeRef = useRef(onChange);
	const onEscapeRef = useRef(onEscape);
	onChangeRef.current = onChange;
	onEscapeRef.current = onEscape;

	useEffect(() => {
		const mount = createMount(holderRef.current, "zf-evo-editor-mount");
		const options = {
			value: textRef.current,
			placeholder: "",
			cls: "content",
			onChange: (update) => {
				const value = update.state.doc.toString();
				if (value === textRef.current) return;
				textRef.current = value;
				onChangeRef.current(value);
			},
			onEscape: () => onEscapeRef.current(),
		};
		let editor;
		try {
			editor = ObsidianBridge.createAnnotationEditor(mount, options);
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Markdown editor unavailable in the note strip; using a plain text box.", e);
			mount.replaceChildren();
			editor = createPlainEditor(mount, options);
		}
		editorRef.current = editor;
		return () => {
			editorRef.current = null;
			try {
				editor.onunload();
			}
			catch (e) {
				console.warn("[ZotFlow Evo] Comment editor did not unload cleanly:", e);
			}
			mount.remove();
		};
	}, [id]);

	// The comment changed elsewhere (a sync, Zotero, another pane).
	useEffect(() => {
		const editor = editorRef.current;
		const next = text || "";
		if (!editor || next === textRef.current) return;
		textRef.current = next;
		try {
			editor.set(next);
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not update the comment editor:", e);
		}
	}, [text]);

	useEffect(() => {
		if (!focusToken) return undefined;
		const win = holderRef.current.ownerDocument.defaultView;
		let giveUp = () => {};
		const timer = win.setTimeout(() => {
			// Not while the annotation is still being pressed, and not at all
			// if the press became a drag (into a note, say).
			giveUp = host.afterPointer((dragged) => {
				if (!dragged) focusEditor(editorRef.current, win);
			});
		}, FOCUS_DELAY);
		return () => {
			win.clearTimeout(timer);
			giveUp();
		};
	}, [focusToken, id, host]);

	return <div className="zf-evo-editor editor" ref={holderRef}/>;
}

function StripPreview({ text, lazy }) {
	const holderRef = useRef();
	const probeRef = useRef();
	const [seen, setSeen] = useState(!lazy);

	// In list mode every comment is in the list; render one as markdown only
	// once it comes near the screen.
	useEffect(() => {
		if (seen) return undefined;
		const probe = probeRef.current;
		const Observer = probe?.ownerDocument.defaultView.IntersectionObserver;
		if (!Observer) {
			setSeen(true);
			return undefined;
		}
		const observer = new Observer((entries) => {
			if (entries.some(entry => entry.isIntersecting)) setSeen(true);
		}, { rootMargin: "600px 0px" });
		observer.observe(probe);
		return () => observer.disconnect();
	}, [seen]);

	useEffect(() => {
		if (!seen) return undefined;
		const el = createMount(holderRef.current, "zf-evo-md");
		let handle = null;
		try {
			handle = ObsidianBridge.renderMarkdownToContainer(el, text || "");
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not render a comment as markdown:", e);
			el.className = "zf-evo-plain";
			el.textContent = text || "";
		}
		return () => {
			try {
				handle?.unload?.();
			}
			catch {
				// Nothing to release.
			}
			el.remove();
		};
	}, [text, seen]);

	return (
		<div className="zf-evo-preview obsidian-app">
			{seen
				? <div ref={holderRef}/>
				: <div className="zf-evo-plain" ref={probeRef}>{text}</div>}
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * One entry
 * ------------------------------------------------------------------ */

/** What was marked on the page: the highlighted text, or the picture. */
function Marked({ annotation }) {
	if (annotation.type === "image" || annotation.type === "ink") {
		return annotation.image
			? <img className="zf-evo-image" src={annotation.image} alt="" draggable={false}/>
			: <span className="zf-evo-faint">{annotation.type === "image" ? "Image" : "Drawing"}</span>;
	}
	return annotation.text || <span className="zf-evo-faint">No text</span>;
}

function Card({
	entry, place, active, list, focusToken, readOnly, host,
	onActivate, onDeactivate, onChange, onMeasure, onColor, onMenu, onLeave,
}) {
	const { annotation, parts } = entry;
	const rootRef = useRef();
	const innerRef = useRef();
	const pageRef = useRef();
	const isNote = annotation.type === "note";
	const editable = active && parts.comment && !readOnly && !annotation.readOnly;

	// Anchored, the layout needs every entry's real height.
	useLayoutEffect(() => {
		if (list) return undefined;
		const inner = innerRef.current;
		const report = () => onMeasure(entry.id, inner.offsetHeight);
		report();
		const observer = new inner.ownerDocument.defaultView.ResizeObserver(report);
		observer.observe(inner);
		return () => observer.disconnect();
	}, [entry.id, list, onMeasure]);

	// The first line is indented by the width of the page number in front of
	// it; the lines after it start underneath the number.
	useLayoutEffect(() => {
		const width = pageRef.current?.offsetWidth || 0;
		rootRef.current.style.setProperty("--zf-evo-indent", (width ? width + 6 : 0) + "px");
	}, [annotation.pageLabel]);

	function handleBlur(event) {
		if (!active) return;
		const root = rootRef.current;
		if (event.relatedTarget && root.contains(event.relatedTarget)) return;
		const doc = root.ownerDocument;
		// After the focus has settled: it may only have moved within the entry.
		doc.defaultView.setTimeout(() => {
			if (!root.isConnected || !doc.hasFocus() || !root.contains(doc.activeElement)) {
				onDeactivate(entry.id);
			}
		}, 0);
	}

	function handleClick(event) {
		if (active) return;
		onActivate(annotation, event);
	}

	function startDrag(event, source) {
		if (annotation._draft || (active && source === "comment")) {
			event.preventDefault();
			return;
		}
		event.stopPropagation();
		event.dataTransfer.effectAllowed = "copy";
		// The payload a dragged annotation carries. Marked as a comment, the
		// plugin drops the comment; otherwise the highlighted text.
		ObsidianBridge.handleSetDataTransferAnnotations(
			event.dataTransfer, [annotation], false, source === "comment" ? { evoSource: "comment" } : undefined
		);
	}

	function handleContextMenu(event) {
		if (annotation._draft) return;
		event.preventDefault();
		onMenu(annotation, event);
	}

	const style = { "--zf-evo-color": annotation.color || DEFAULT_NOTE_COLOR };
	if (!list && place) {
		style.top = place.top;
		if (active) style.minHeight = place.height;
		else style.height = place.height;
	}

	return (
		<div
			ref={rootRef}
			className={cx("zf-evo-card", {
				"is-active": active,
				"is-clamped": !active && !list && place?.clamped,
			})}
			style={style}
			data-entry-id={entry.id}
			data-annotation-id={annotation._draft ? undefined : annotation.id}
			onClick={handleClick}
			onBlur={handleBlur}
			onContextMenu={handleContextMenu}
		>
			<span className="zf-evo-page" aria-hidden="true" ref={pageRef}>{annotation.pageLabel || ""}</span>
			<div className="zf-evo-card-clip">
				<div className="zf-evo-card-inner" ref={innerRef}>
					{parts.highlight && (
						<div
							className="zf-evo-row is-highlight is-first"
							draggable={!annotation._draft}
							onDragStart={event => startDrag(event, "highlight")}
						>
							<span className="zf-evo-bars" aria-hidden="true">
								<span className="zf-evo-bar"/>
							</span>
							<div className="zf-evo-quote"><Marked annotation={annotation}/></div>
						</div>
					)}
					{parts.comment && (
						<div
							className={cx("zf-evo-row is-comment", { "is-first": !parts.highlight })}
							draggable={!active && !annotation._draft}
							onDragStart={event => startDrag(event, "comment")}
						>
							<span className="zf-evo-bars" aria-hidden="true">
								<span className="zf-evo-bar"/>
								<span className="zf-evo-bar"/>
							</span>
							{editable
								? (
									<StripEditor
										id={annotation.id}
										text={annotation.comment}
										focusToken={focusToken}
										host={host}
										onChange={text => onChange(annotation.id, text)}
										onEscape={onLeave}
									/>
								)
								: <StripPreview text={annotation.comment} lazy={list}/>}
							{editable && isNote && (
								<div className="zf-evo-palette" role="group" aria-label="Note colour">
									{PALETTE.map((color, index) => (
										<button
											key={color}
											type="button"
											className={cx("zf-evo-swatch", { "is-current": color === String(annotation.color || "").toLowerCase() })}
											style={{ "--zf-evo-color": color }}
											title={`${COLOR_NAMES.get(color)} (Alt+${index + 1})`}
											onClick={() => onColor(annotation.id, color)}
										/>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function Heading({ entry, place, list, onOpen }) {
	const { heading } = entry;
	return (
		<div
			className="zf-evo-heading"
			style={!list && place ? { top: place.top, height: place.height } : undefined}
			data-entry-id={entry.id}
			data-depth={heading.depth}
			title={heading.title}
			onClick={list ? () => onOpen(heading) : undefined}
		>
			{heading.title}
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * The head: title line, buttons, colour filters
 * ------------------------------------------------------------------ */

function IconHighlights() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<rect x="1.5" y="3" width="13" height="4" rx="1" fill="currentColor" opacity="0.35"/>
			<rect x="1.5" y="9" width="9" height="4" rx="1" fill="currentColor" opacity="0.35"/>
			<path d="M3 5h10M3 11h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none"/>
		</svg>
	);
}

function IconPlus() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
		</svg>
	);
}

function StripHead({ annotations, settings, colors, readOnly, onToggleColor, onToggleHighlights, onNewNote }) {
	const swatches = useMemo(() => {
		const used = usedColors(annotations, PALETTE);
		// A chosen colour stays on offer after its last annotation is gone,
		// so the filter can still be taken off.
		for (const color of colors) {
			if (!used.includes(color)) used.push(color);
		}
		return used;
	}, [annotations, colors]);
	const showHighlights = !!settings.highlights;
	return (
		<div className="zf-evo-head">
			{settings.banner && <div className="zf-evo-head-title" title={settings.banner}>{settings.banner}</div>}
			<div className="zf-evo-head-tools">
				<button
					type="button"
					className={cx("zf-evo-tool", { "is-on": showHighlights })}
					title={showHighlights ? "Hide highlights" : "Show highlights"}
					aria-pressed={showHighlights}
					data-tool="highlights"
					onClick={onToggleHighlights}
				>
					<IconHighlights/>
				</button>
				{!readOnly && (
					<button
						type="button"
						className="zf-evo-tool"
						title="New note on this page"
						data-tool="new-note"
						onClick={onNewNote}
					>
						<IconPlus/>
					</button>
				)}
				<span className="zf-evo-filters" role="group" aria-label="Show only these colours">
					{swatches.map(color => (
						<button
							key={color}
							type="button"
							className={cx("zf-evo-swatch", {
								"is-current": colors.has(color),
								"is-dimmed": colors.size > 0 && !colors.has(color),
							})}
							style={{ "--zf-evo-color": color }}
							title={`Only ${COLOR_NAMES.get(color) || color}`}
							aria-pressed={colors.has(color)}
							data-color={color}
							onClick={() => onToggleColor(color)}
						/>
					))}
				</span>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------ */

function Strip({
	host, state, settings, colors, actions,
	onUpdateAnnotations, onSelectAnnotations, onOpenAnnotationContextMenu, onNavigate,
}) {
	const reader = window._reader;
	const collapsed = !!settings.collapsed;
	const showHighlights = !!settings.highlights;
	const readOnly = !!state.readOnly;
	const [tick, bump] = useReducer(n => n + 1, 0);
	const [scrollSlot, setScrollSlot] = useState(0);
	const [activeId, setActiveId] = useState(null);
	const [focusToken, setFocusToken] = useState(0);
	// A note being typed that Zotero does not know yet. It becomes an
	// annotation with its first character, so nothing empty is ever saved.
	const [draft, setDraft] = useState(null);
	const activeRef = useRef(null);
	const draftRef = useRef(null);
	const heights = useRef(new Map());
	const measuring = useRef(false);
	const noteColor = useRef(null);
	const draftCount = useRef(0);
	activeRef.current = activeId;
	draftRef.current = draft;

	useEffect(() => {
		host.setWidth(settings.width);
	}, [host, settings.width]);
	useEffect(() => {
		host.setCollapsed(collapsed);
	}, [host, collapsed]);

	useEffect(() => host.on((event) => {
		if (event.type === "geometry") bump();
		else setScrollSlot(Math.floor(host.scrollTop / SCROLL_STEP));
	}), [host]);

	const activate = useCallback((id) => {
		setActiveId(id);
		setFocusToken(token => token + 1);
	}, []);

	const endDraft = useCallback(() => {
		const current = draftRef.current;
		if (!current) return;
		setDraft(null);
		// Typed and then emptied again: do not leave an empty note behind.
		if (current.createdId) {
			const made = reader._state.annotations.find(x => x.id === current.createdId);
			if (made && !made.comment) reader._annotationManager.deleteAnnotations([made.id]);
		}
	}, [reader]);

	const deactivate = useCallback((id) => {
		if (activeRef.current !== id) return;
		setActiveId(null);
		if (draftRef.current?.id === id) endDraft();
	}, [endDraft]);

	// Selecting an annotation on the page opens its comment in the strip.
	const selected = state.selectedAnnotationIDs;
	useEffect(() => {
		if (selected.length === 1) {
			const id = selected[0];
			if (id === activeRef.current || id === draftRef.current?.createdId) return;
			const annotation = reader._state.annotations.find(x => x.id === id);
			if (!annotation || readOnly || annotation.readOnly) return;
			if (!["highlight", "underline", "note", "image", "ink"].includes(annotation.type)) return;
			if (draftRef.current) endDraft();
			activate(id);
		}
		else if (!selected.length && activeRef.current && !draftRef.current) {
			const doc = host.stripDoc;
			if (!doc.hasFocus()) setActiveId(null);
		}
		// Runs when the selection changes, and only then.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected]);

	// Anchored, the strip does not scroll by itself, so the pages are
	// scrolled to keep the cursor of the open comment in view.
	useEffect(() => {
		if (!activeId || collapsed) return undefined;
		const doc = host.stripDoc;
		const follow = () => {
			if (!doc.hasFocus()) return;
			const box = doc.activeElement;
			if (!box || box === doc.body) return;
			let rect = null;
			if (box.matches("textarea")) {
				// No cursor position to ask for: follow the end of the text.
				if (box.selectionEnd !== box.value.length) return;
				const all = box.getBoundingClientRect();
				rect = { top: all.bottom - LINE_HEIGHT, bottom: all.bottom };
			}
			else {
				const selection = doc.getSelection();
				if (!selection?.rangeCount) return;
				const range = selection.getRangeAt(0).cloneRange();
				range.collapse(false);
				rect = range.getClientRects()[0] || null;
				// An empty line has no rectangle of its own.
				if (!rect) {
					const node = range.startContainer;
					const el = node.nodeType === 1 ? node.childNodes[range.startOffset] || node : node.parentElement;
					rect = el?.getBoundingClientRect?.() || null;
				}
			}
			if (rect && (rect.top || rect.bottom)) host.reveal(rect.top, rect.bottom);
		};
		doc.addEventListener("selectionchange", follow);
		return () => doc.removeEventListener("selectionchange", follow);
	}, [activeId, collapsed, host]);

	// As a list, the strip scrolls by itself: bring the opened entry into view.
	useEffect(() => {
		if (!activeId || !collapsed) return;
		const el = host.stripDoc.querySelector(`[data-entry-id="${CSS.escape(activeId)}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [activeId, collapsed, host]);

	const handleMeasure = useCallback((id, height) => {
		height = Math.ceil(height);
		if (!height || heights.current.get(id) === height) return;
		heights.current.set(id, height);
		if (measuring.current) return;
		measuring.current = true;
		host.stripWin.requestAnimationFrame(() => {
			measuring.current = false;
			bump();
		});
	}, [host]);

	const handleChange = useCallback((id, text) => {
		const current = draftRef.current;
		if (current && current.id === id) {
			if (current.createdId) {
				onUpdateAnnotations([{ id: current.createdId, comment: text }]);
			}
			else if (text.trim()) {
				const made = reader._annotationManager.addAnnotation({
					type: "note",
					color: current.color,
					comment: text,
					pageLabel: current.pageLabel,
					sortIndex: current.sortIndex,
					position: current.position,
				});
				if (made) current.createdId = made.id;
			}
			current.comment = text;
			return;
		}
		onUpdateAnnotations([{ id, comment: text }]);
	}, [onUpdateAnnotations, reader]);

	const handleColor = useCallback((id, color) => {
		const current = draftRef.current;
		if (current && current.id === id) {
			noteColor.current = color;
			if (current.createdId) onUpdateAnnotations([{ id: current.createdId, color }]);
			setDraft({ ...current, color });
			return;
		}
		const annotation = reader._state.annotations.find(x => x.id === id);
		if (!annotation || annotation.readOnly) return;
		if (annotation.type === "note") noteColor.current = color;
		onUpdateAnnotations([{ id, color }]);
	}, [onUpdateAnnotations, reader]);

	// Alt+1 … Alt+8 give the open entry the first … eighth colour.
	useEffect(() => {
		const doc = host.stripDoc;
		const onKeyDown = (event) => {
			if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			const match = /^(?:Digit|Numpad)([1-8])$/.exec(event.code || "");
			const id = activeRef.current;
			if (!match || !id || readOnly) return;
			// Also keeps the character Alt+digit types on some keyboards out
			// of the comment.
			event.preventDefault();
			event.stopPropagation();
			handleColor(id, PALETTE[Number(match[1]) - 1]);
		};
		doc.addEventListener("keydown", onKeyDown, true);
		return () => doc.removeEventListener("keydown", onKeyDown, true);
	}, [host, handleColor, readOnly]);

	const handleActivate = useCallback((annotation, event) => {
		if (annotation._draft) return;
		if (draftRef.current) endDraft();
		// Anchored, the annotation is already beside its entry; as a list the
		// page is brought to it.
		onSelectAnnotations([annotation.id], !collapsed, event);
		if (readOnly || annotation.readOnly) return;
		activate(annotation.id);
	}, [activate, collapsed, endDraft, onSelectAnnotations, readOnly]);

	const handleMenu = useCallback((annotation, event) => {
		const { x, y } = host.toReaderPoint(event.clientX, event.clientY);
		onOpenAnnotationContextMenu({ ids: [annotation.id], currentID: annotation.id, x, y });
	}, [host, onOpenAnnotationContextMenu]);

	const handleLeave = useCallback(() => host.focusView(), [host]);

	const handleHeading = useCallback((heading) => {
		onNavigate(heading.location);
	}, [onNavigate]);

	const startDraft = useCallback((spot) => {
		if (!spot || readOnly) return;
		if (draftRef.current) endDraft();
		// The note being written is the only thing in hand.
		if (reader._state.selectedAnnotationIDs.length) onSelectAnnotations([], true);
		const id = `zf-evo-draft-${++draftCount.current}`;
		setDraft({
			id,
			_draft: true,
			type: "note",
			color: noteColor.current || reader._tools?.note?.color || DEFAULT_NOTE_COLOR,
			comment: "",
			pageLabel: spot.pageLabel,
			sortIndex: spot.sortIndex,
			position: spot.position,
			anchor: spot.anchor,
			createdId: null,
		});
		activate(id);
	}, [activate, endDraft, onSelectAnnotations, reader, readOnly]);

	// A note for the page being read: stored at the start of that page, after
	// the notes already there.
	const startPageNote = useCallback(() => {
		const pageIndex = host.currentPageIndex;
		const { slot, sortIndex } = pageStartSlot(pageIndex, reader._state.annotations);
		const spot = host.pageStartSpot(pageIndex, slot);
		if (spot) startDraft({ ...spot, sortIndex });
	}, [host, reader, startDraft]);
	actions.current.newNote = startPageNote;

	// A click on empty space starts a note: anchored, on the line clicked;
	// as a list, for the page being read.
	function handleStripClick(event) {
		if (event.target !== event.currentTarget || readOnly) return;
		if (collapsed) startPageNote();
		else startDraft(host.spotAt(event.clientY));
	}

	// The outline. The reader reads it only when its own outline tab is
	// opened (`null` until then), so ask for it; and have the page texts
	// read that put its headings in order among the annotations.
	const outlineAsked = useRef(false);
	useEffect(() => {
		if (state.outline !== null || outlineAsked.current) return;
		outlineAsked.current = true;
		host.loadOutline();
	}, [state.outline, host]);
	const headings = useMemo(() => flattenOutline(state.outline), [state.outline]);
	useEffect(() => {
		let cancelled = false;
		const pages = [...new Set(headings.map(heading => heading.pageIndex))]
			.filter(pageIndex => !host.hasPageText(pageIndex));
		if (!pages.length) return undefined;
		(async () => {
			let done = 0;
			for (const pageIndex of pages) {
				if (cancelled) return;
				try {
					await host.ensurePageText(pageIndex);
				}
				catch {
					// That heading keeps its rough place.
				}
				if (++done % 10 === 0 && !cancelled) bump();
			}
			if (!cancelled) bump();
		})();
		return () => {
			cancelled = true;
		};
	}, [headings, host]);

	const annotations = state.annotations;
	const model = useMemo(() => {
		const entries = buildEntries({
			annotations,
			headings: headings.map(heading => ({ ...heading, sortIndex: host.headingSortIndex(heading) })),
			draft,
			activeId,
			showHighlights,
			colors,
		});
		if (collapsed) return { entries, placed: null };
		// Anchored: every entry on its line, beside its place on the page.
		const items = [];
		for (const entry of entries) {
			let anchor;
			if (entry.kind === "heading") anchor = host.headingAnchor(entry.heading);
			else if (entry.annotation._draft) anchor = entry.annotation.anchor;
			else anchor = host.anchorOf(entry.annotation);
			if (anchor === null || anchor === undefined) continue;
			entry.anchor = anchor;
			if (entry.kind === "heading") {
				entry.natural = LINE_HEIGHT;
			}
			else {
				const text = [entry.parts.highlight && entry.annotation.text, entry.parts.comment && entry.annotation.comment]
					.filter(Boolean).join("\n");
				entry.natural = heights.current.get(entry.id) ?? estimateHeight(text, host.width);
			}
			items.push(entry);
		}
		items.sort((a, b) => a.anchor - b.anchor || (a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0));
		return { entries: items, placed: layoutCards(items) };
		// `tick` stands for what the host measures (page positions, zoom, page
		// texts) and for the heights in `heights`, none of which React sees.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [annotations, headings, activeId, draft, collapsed, showHighlights, colors, tick, host]);

	// Anchored, only the entries near the visible part are rendered.
	// `scrollSlot` changes every SCROLL_STEP pixels of scrolling, which is
	// when the set is looked at again.
	const visible = useMemo(() => {
		if (collapsed) return model.entries;
		const from = host.scrollTop - OVERSCAN;
		const to = host.scrollTop + host.clientHeight + OVERSCAN;
		return model.entries.filter((entry) => {
			if (entry.id === activeId) return true;
			const place = model.placed.get(entry.id);
			return place.top + Math.max(place.height, entry.natural) >= from && place.top <= to;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- scrollSlot is the trigger
	}, [model, collapsed, activeId, host, scrollSlot]);

	const nothing = collapsed && !visible.some(entry => entry.kind === "annotation");

	return (
		<div
			className={cx("zf-evo-strip", { "is-list": collapsed, "is-read-only": readOnly })}
			style={collapsed ? undefined : { height: host.contentHeight }}
			onClick={handleStripClick}
		>
			{visible.map(entry => (entry.kind === "heading"
				? (
					<Heading
						key={entry.id}
						entry={entry}
						place={model.placed?.get(entry.id)}
						list={collapsed}
						onOpen={handleHeading}
					/>
				)
				: (
					<Card
						key={entry.id}
						entry={entry}
						place={model.placed?.get(entry.id)}
						active={entry.id === activeId}
						list={collapsed}
						focusToken={entry.id === activeId ? focusToken : 0}
						readOnly={readOnly}
						host={host}
						onActivate={handleActivate}
						onDeactivate={deactivate}
						onChange={handleChange}
						onMeasure={handleMeasure}
						onColor={handleColor}
						onMenu={handleMenu}
						onLeave={handleLeave}
					/>
				)))}
			{nothing && (
				<div className="zf-evo-empty">
					{colors.size
						? "Nothing in this colour."
						: readOnly ? "No comments." : "No comments yet. Click here to write a note for this page."}
				</div>
			)}
		</div>
	);
}

/** The head and the strip, which share the colour filter. */
function StripRoot({ host, state, settings, ...handlers }) {
	const [colors, setColors] = useState(() => new Set());
	const actions = useRef({});

	const toggleColor = useCallback((color) => {
		setColors((current) => {
			const next = new Set(current);
			if (!next.delete(color)) next.add(color);
			return next;
		});
	}, []);

	const toggleHighlights = useCallback(() => {
		// Kept by the plugin, so it holds for the next PDF too.
		reportNoteStrip(window._reader, { highlights: !settings.highlights });
	}, [settings.highlights]);

	const newNote = useCallback(() => actions.current.newNote?.(), []);

	return (
		<>
			{createPortal(
				<StripHead
					annotations={state.annotations}
					settings={settings}
					colors={colors}
					readOnly={!!state.readOnly}
					onToggleColor={toggleColor}
					onToggleHighlights={toggleHighlights}
					onNewNote={newNote}
				/>,
				host.headMount
			)}
			{createPortal(
				<Strip
					host={host}
					state={state}
					settings={settings}
					colors={colors}
					actions={actions}
					{...handlers}
				/>,
				host.mount
			)}
		</>
	);
}

function useStripHost(view) {
	const [host, setHost] = useState(null);
	useEffect(() => {
		if (!view) return undefined;
		let created;
		let gone = false;
		try {
			created = new EvoStripHost(view);
			created.setVisible(true);
		}
		catch (e) {
			console.error("[ZotFlow Evo] The note strip could not start:", e);
			created?.destroy();
			// Without the strip the comment popup is needed again: it is
			// held back only while the strip counts as shown.
			applyNoteStrip(window._reader, { visible: false });
			return undefined;
		}
		created.ready.then(() => {
			if (!gone) setHost(created);
		});
		return () => {
			gone = true;
			created.destroy();
			setHost(null);
		};
	}, [view]);
	return host;
}

/**
 * Rendered once by ReaderUI. Draws nothing in the reader's own document:
 * the strip is drawn through portals into its documents inside the PDF view.
 */
export default function EvoNoteStrip(props) {
	const settings = props.state[NOTE_STRIP_STATE];
	const view = props.type === "pdf" && settings?.visible
		? window._reader?._primaryView || null
		: null;
	const host = useStripHost(view);
	if (!host || !settings?.visible) return null;
	return (
		<StripRoot
			host={host}
			state={props.state}
			settings={settings}
			onUpdateAnnotations={props.onUpdateAnnotations}
			onSelectAnnotations={props.onSelectAnnotations}
			onOpenAnnotationContextMenu={props.onOpenAnnotationContextMenu}
			onNavigate={props.onNavigate}
		/>
	);
}
