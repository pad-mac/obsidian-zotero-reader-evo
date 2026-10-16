/**
 * ZotFlow Evo — the note strip: the comments of a PDF or a snapshot, beside
 * the document.
 *
 * Rendered by the reader's React tree (one line in reader-ui.js) into the
 * strip's own documents (`strip-host.js`): a pinned head (title line,
 * buttons, colour filters) and the strip itself. Beside a PDF they stand
 * inside the PDF view (`strip-host-pdf.js`), beside a snapshot in the
 * reader's document (`strip-host-dom.js`). What is listed, and in what
 * order, is decided in `strip-layout.mjs`.
 *
 * The strip shows what Zotero stores:
 *  - comments — of a highlight, underline, image or ink annotation, and note
 *    annotations — each with two bars in the annotation's colour;
 *  - with "highlights" switched on, what was marked in the text as well: the
 *    full text of each highlight, with one bar;
 *  - the document's outline, as plain headings between them.
 *
 * It has two modes. As a list (the default) it is a column of its own, like
 * the reader's annotations sidebar. Anchored — beside a PDF only — every
 * entry sits beside its place on the page and the strip scrolls with the
 * pages.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import cx from "classnames";
import { ObsidianBridge } from "../obsidian-adapter";
import { ANNOTATION_COLORS } from "../common/defines";
import { NOTE_STRIP_STATE, applyNoteStrip, hasNoteStrip, reportNoteStrip, reportNoteStripAction } from "../obsidian-evo";
import { PdfStripHost } from "./strip-host-pdf";
import { DomStripHost } from "./strip-host-dom";
import {
	arrowTargets, buildEntries, estimateHeight, flattenOutline, foldEntries, layoutCards, sortIndexAfter, titleRuns,
	usedColors, LINE_HEIGHT,
} from "./strip-layout.mjs";

export { hasNoteStrip };

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

/**
 * The first line of an entry is indented by the width of the page number in
 * front of it. The width is measured, and measured again whenever it
 * changes: a number measured before the strip was laid out, or before its
 * font arrived, would otherwise leave the text running over it. One observer
 * per document serves all entries.
 */
const indentObservers = new WeakMap();

function setIndent(card, width) {
	card.style.setProperty("--zf-evo-indent", (width ? width + 6 : 0) + "px");
}

function watchIndent(pageEl, card) {
	const win = pageEl.ownerDocument.defaultView;
	let observer = indentObservers.get(win);
	if (!observer) {
		observer = new win.ResizeObserver((records) => {
			for (const record of records) {
				const target = record.target.closest(".zf-evo-card");
				if (target) setIndent(target, record.target.offsetWidth);
			}
		});
		indentObservers.set(win, observer);
	}
	setIndent(card, pageEl.offsetWidth);
	observer.observe(pageEl);
	return () => observer.unobserve(pageEl);
}

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
	useLayoutEffect(() => watchIndent(pageRef.current, rootRef.current), []);

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
		// Text was selected (Alt and drag): leave the selection be.
		const selection = rootRef.current.ownerDocument.getSelection();
		if (selection && !selection.isCollapsed && rootRef.current.contains(selection.anchorNode)) return;
		onActivate(annotation, event);
	}

	// A row is dragged into a note. With Alt held the press selects text
	// instead: the row stops being draggable until the button is let go.
	function handlePointerDown(event) {
		if (!event.altKey || event.button !== 0) return;
		const row = event.target.closest?.(".zf-evo-row");
		if (!row || !row.draggable) return;
		row.draggable = false;
		row.classList.add("is-selecting");
		const doc = row.ownerDocument;
		const restore = () => {
			doc.removeEventListener("pointerup", restore, true);
			doc.removeEventListener("pointercancel", restore, true);
			row.classList.remove("is-selecting");
			// Back as React rendered it.
			row.draggable = row.dataset.draggable === "true";
		};
		doc.addEventListener("pointerup", restore, true);
		doc.addEventListener("pointercancel", restore, true);
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
			onPointerDownCapture={handlePointerDown}
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
							data-draggable={String(!annotation._draft)}
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
							data-draggable={String(!active && !annotation._draft)}
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

function IconChevron({ open }) {
	return (
		<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={cx("zf-evo-chevron", { "is-open": open })}>
			<path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
		</svg>
	);
}

function Heading({ entry, place, list, onOpen, onFold }) {
	const { heading } = entry;
	// As a list a chapter can be folded away; beside the page everything
	// stays where it is.
	const foldable = list && entry.hasContent;
	function handleFold(event) {
		event.stopPropagation();
		onFold(entry, event.altKey);
	}
	return (
		<div
			className={cx("zf-evo-heading", { "is-folded": entry.folded })}
			style={{
				"--zf-evo-depth": heading.depth || 0,
				...(!list && place ? { top: place.top, height: place.height } : null),
			}}
			data-entry-id={entry.id}
			data-depth={heading.depth}
			title={heading.title}
		>
			{list && (
				<span
					className={cx("zf-evo-fold", { "is-empty": !foldable })}
					role={foldable ? "button" : undefined}
					aria-label={foldable ? (entry.folded ? "Unfold" : "Fold") : undefined}
					aria-expanded={foldable ? !entry.folded : undefined}
					title={foldable ? "Fold or unfold (with Alt: all headings of this level)" : undefined}
					onClick={foldable ? handleFold : undefined}
				>
					{foldable && <IconChevron open={!entry.folded}/>}
				</span>
			)}
			<span
				className="zf-evo-heading-title"
				onClick={list ? () => onOpen(heading) : undefined}
			>
				{heading.title}
			</span>
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * The head: title line, buttons, colour filters
 * ------------------------------------------------------------------ */

/** The authors on one line, fading out before the year when they do not fit. */
function Byline({ authors, year }) {
	const ref = useRef();
	const [overflowing, setOverflowing] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return undefined;
		const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
		check();
		const observer = new el.ownerDocument.defaultView.ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [authors]);
	return (
		<div className="zf-evo-head-byline">
			<span ref={ref} className={cx("zf-evo-head-authors", { "is-overflowing": overflowing })} title={authors}>{authors}</span>
			{year && <span className="zf-evo-head-year">{year}</span>}
		</div>
	);
}

/**
 * The two lines above the strip: the authors (all of them) with the year at
 * the right end, then the full title. `banner` is `{ authors, year, title }`
 * or just a text (shown as the title).
 */
function HeadBanner({ banner }) {
	if (!banner) return null;
	const { authors = "", year = "", title = "" } = typeof banner === "string" ? { title: banner } : banner;
	return (
		<>
			{(authors || year) && <Byline authors={authors} year={year}/>}
			{title && (
				<div className="zf-evo-head-title">
					{titleRuns(title).map((run, i) => (run.italic ? <i key={i}>{run.text}</i> : <React.Fragment key={i}>{run.text}</React.Fragment>))}
				</div>
			)}
		</>
	);
}

/**
 * Lucide's highlighter, as Obsidian draws its icons. On: in the accent
 * colour, with a stroke of ink under it; off: muted and struck through.
 */
function IconHighlights({ on }) {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="m9 11-6 6v3h9l3-3"/>
			<path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
			{on
				? <path d="M14 22h7" strokeWidth="3" opacity="0.55"/>
				: <path d="M3 3l18 18"/>}
		</svg>
	);
}

/** Lucide's plus. */
function IconPlus() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M5 12h14"/>
			<path d="M12 5v14"/>
		</svg>
	);
}

/**
 * A button of the Obsidian view, while the view's header is hidden: its
 * icon as Obsidian drew it, a click passed on to the real button.
 */
function ViewAction({ action, onAction }) {
	return (
		<button
			type="button"
			className="zf-evo-tool is-view-action"
			title={action.title}
			aria-label={action.title}
			data-action={action.id}
			onClick={event => onAction(action.id, event)}
			// Obsidian's own icon markup (the plugin sends what it drew).
			dangerouslySetInnerHTML={{ __html: action.icon || "" }}
		/>
	);
}

function StripHead({ annotations, settings, colors, readOnly, paged, onToggleColor, onToggleHighlights, onNewNote, onAction }) {
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
			<HeadBanner banner={settings.banner}/>
			<div className="zf-evo-head-tools">
				{(settings.actions || []).map(action => (
					<ViewAction key={action.id} action={action} onAction={onAction}/>
				))}
				{settings.actions?.length > 0 && <span className="zf-evo-tool-gap" aria-hidden="true"/>}
				<button
					type="button"
					className={cx("zf-evo-tool", { "is-on": showHighlights })}
					title={showHighlights ? "Hide highlights" : "Show highlights"}
					aria-pressed={showHighlights}
					data-tool="highlights"
					onClick={onToggleHighlights}
				>
					<IconHighlights on={showHighlights}/>
				</button>
				{!readOnly && (
					<button
						type="button"
						className="zf-evo-tool"
						title={paged ? "New note on this page" : "New note here"}
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
	host, state, settings, colors, actions, paged, folded, onFold,
	onUpdateAnnotations, onSelectAnnotations, onOpenAnnotationContextMenu, onNavigate,
}) {
	const reader = window._reader;
	// Beside a snapshot the strip is a list, whatever is set for PDFs.
	const collapsed = !!settings.collapsed || !host.canAnchor;
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
	// Whether the comment of the open entry was written in since it was
	// opened (see the Delete key below).
	const touched = useRef(false);
	// The annotations with the places the strip orders them by.
	const annotations = useMemo(() => host.withPlaces(state.annotations), [host, state.annotations]);
	const annotationsRef = useRef(annotations);
	activeRef.current = activeId;
	draftRef.current = draft;
	annotationsRef.current = annotations;

	useEffect(() => {
		host.setWidth(settings.width);
	}, [host, settings.width]);
	useEffect(() => {
		host.setCollapsed(collapsed);
	}, [host, collapsed]);

	useEffect(() => host.on((event) => {
		if (event.type === "geometry") bump();
		else if (event.type === "resized") {
			// Dragged wider or narrower: kept by the plugin, for every reader.
			reportNoteStrip(reader, { width: event.width });
		}
		else setScrollSlot(Math.floor(host.scrollTop / SCROLL_STEP));
	}), [host, reader]);

	const activate = useCallback((id) => {
		touched.current = false;
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
		if (id === activeRef.current) touched.current = true;
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

	// A note that follows an entry of the list: stored at the same place in
	// the text as that entry, and ordered right after it.
	const startNoteAfter = useCallback((target) => {
		const spot = host.spotAfter(target);
		if (!spot) return;
		startDraft({ ...spot, sortIndex: sortIndexAfter(target.sortIndex, annotationsRef.current) });
	}, [host, startDraft]);

	// A note for what is being read (the "+" button): after the last thing
	// listed on the page — beside a snapshot: on the screen —, or with nothing
	// there yet at a place of its own.
	const startNoteHere = useCallback(() => {
		const place = host.readingPlace(annotationsRef.current);
		if (place?.after) startNoteAfter({ annotation: place.after, sortIndex: place.after.sortIndex });
		else if (place?.spot) startDraft(place.spot);
	}, [host, startDraft, startNoteAfter]);
	actions.current.newNote = startNoteHere;

	// A new note right under an entry of the list (see handleStripClick()).
	const startNoteUnder = useCallback((entry) => {
		if (entry.kind === "heading") {
			startNoteAfter({ heading: entry.heading, sortIndex: entry.sortIndex });
		}
		else if (entry.annotation._draft) {
			// Under the note being written: after it, if it has become an
			// annotation; if nothing was typed, in its place.
			const { createdId, position, pageLabel, sortIndex, anchor } = entry.annotation;
			const made = createdId && reader._state.annotations.find(x => x.id === createdId);
			if (made) startNoteAfter({ annotation: made, sortIndex: made.sortIndex });
			else startDraft({ position, pageLabel, sortIndex, anchor });
		}
		else {
			startNoteAfter({ annotation: entry.annotation, sortIndex: entry.annotation.sortIndex });
		}
	}, [reader, startDraft, startNoteAfter]);
	const entriesRef = useRef([]);

	// Keys while an entry is open:
	//  - Shift+Enter starts a new note under it (under a highlight's comment:
	//    a note of its own, right after the highlight);
	//  - Delete or Backspace in the comment of an annotation, while the
	//    comment is empty and nothing was typed since it was opened, deletes
	//    the annotation — as in the reader's own comment popup.
	useEffect(() => {
		const doc = host.stripDoc;
		const onKeyDown = (event) => {
			const id = activeRef.current;
			if (!id || readOnly || event.ctrlKey || event.metaKey || event.altKey) return;
			if (event.key === "Enter" && event.shiftKey) {
				const entry = entriesRef.current.find(x => x.id === id);
				if (!entry) return;
				event.preventDefault();
				event.stopPropagation();
				startNoteUnder(entry);
				return;
			}
			if ((event.key === "Delete" || event.key === "Backspace") && !event.shiftKey) {
				if (touched.current || draftRef.current?.id === id) return;
				const annotation = reader._state.annotations.find(x => x.id === id);
				if (!annotation || annotation.readOnly || annotation.comment) return;
				event.preventDefault();
				event.stopPropagation();
				setActiveId(null);
				reader.deleteAnnotations([id]);
				host.focusView();
			}
		};
		doc.addEventListener("keydown", onKeyDown, true);
		return () => doc.removeEventListener("keydown", onKeyDown, true);
	}, [host, reader, readOnly, startNoteUnder]);

	// The outline. The reader reads it only when its own outline tab is
	// opened (`null` until then), so ask for it; and have the page texts
	// read that put its headings in order among the annotations.
	const outlineAsked = useRef(false);
	useEffect(() => {
		if (state.outline !== null || outlineAsked.current) return;
		outlineAsked.current = true;
		host.loadOutline();
	}, [state.outline, host]);
	const headings = useMemo(() => {
		const flat = flattenOutline(state.outline);
		host.prepareHeadings(flat);
		return flat;
	}, [state.outline, host]);
	useEffect(() => {
		let cancelled = false;
		const pages = [...new Set(headings.map(heading => heading.pageIndex))]
			.filter(pageIndex => Number.isInteger(pageIndex) && !host.hasPageText(pageIndex));
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

	const model = useMemo(() => {
		const entries = buildEntries({
			annotations,
			headings: headings
				.map(heading => ({ ...heading, sortIndex: host.headingSortIndex(heading) }))
				.filter(heading => heading.sortIndex),
			draft,
			activeId,
			showHighlights,
			colors,
		});
		// Whether anything is listed at all, folded away or not.
		const any = entries.some(entry => entry.kind === "annotation");
		if (collapsed) return { entries: foldEntries(entries, folded), placed: null, any };
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
		return { entries: items, placed: layoutCards(items), any };
		// `tick` stands for what the host measures (page positions, zoom, page
		// texts) and for the heights in `heights`, none of which React sees.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [annotations, headings, activeId, draft, collapsed, showHighlights, colors, folded, tick, host]);

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

	// A click on empty space starts a note: anchored, on the line clicked; as
	// a list, after the entry above the click.
	function handleStripClick(event) {
		if (event.target !== event.currentTarget || readOnly) return;
		if (!collapsed) {
			startDraft(host.spotAt(event.clientY));
			return;
		}
		let above = null;
		for (const el of event.currentTarget.children) {
			if (!el.dataset.entryId) continue;
			if (el.getBoundingClientRect().top > event.clientY) break;
			above = el.dataset.entryId;
		}
		const entry = above && model.entries.find(x => x.id === above);
		if (entry) startNoteUnder(entry);
		else startNoteHere();
	}

	entriesRef.current = model.entries;

	const handleFold = useCallback((entry, all) => {
		const depth = entry.heading.depth;
		const ids = all
			? model.entries.filter(x => x.kind === "heading" && x.heading.depth === depth && x.hasContent).map(x => x.id)
			: [entry.id];
		onFold(ids, !entry.folded);
	}, [model, onFold]);

	// Folded headings hide their comments; that is not "no comments".
	const nothing = collapsed && !model.any;

	// Anchored, with no comment in view: arrows at the top and the bottom
	// with the page of the nearest comment that way (strip-host-pdf.js).
	useEffect(() => {
		if (collapsed) {
			host.setArrows(null, null);
			return undefined;
		}
		const update = () => {
			const targets = arrowTargets(model.entries, model.placed, host.viewTop, host.scrollTop + host.clientHeight);
			host.setArrows(
				targets?.up ? targets.up.annotation.pageLabel ?? "" : null,
				targets?.down ? targets.down.annotation.pageLabel ?? "" : null,
			);
		};
		update();
		const off = host.on((event) => {
			if (event.type === "scroll" || event.type === "geometry") update();
		});
		return () => {
			off();
			host.setArrows(null, null);
		};
	}, [host, model, collapsed]);

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
						onFold={handleFold}
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
						: readOnly
							? "No comments."
							: `No comments yet. Click here to write a note${paged ? " for this page" : ""}.`}
				</div>
			)}
		</div>
	);
}

/** The head and the strip, which share the colour filter. */
function StripRoot({ host, state, settings, paged, ...handlers }) {
	const [colors, setColors] = useState(() => new Set());
	// Outline headings folded away (list only), for this document.
	const [folded, setFolded] = useState(() => new Set());
	const actions = useRef({});

	const fold = useCallback((ids, shut) => {
		setFolded((current) => {
			const next = new Set(current);
			for (const id of ids) {
				if (shut) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	}, []);

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

	const viewAction = useCallback((id, event) => {
		const { x, y } = host.toTopPoint(host.head, event.clientX, event.clientY);
		reportNoteStripAction(id, x, y);
	}, [host]);

	return (
		<>
			{createPortal(
				<StripHead
					annotations={state.annotations}
					settings={settings}
					colors={colors}
					readOnly={!!state.readOnly}
					paged={paged}
					onToggleColor={toggleColor}
					onToggleHighlights={toggleHighlights}
					onNewNote={newNote}
					onAction={viewAction}
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
					paged={paged}
					folded={folded}
					onFold={fold}
					{...handlers}
				/>,
				host.mount
			)}
		</>
	);
}

function useStripHost(view, type) {
	const [host, setHost] = useState(null);
	useEffect(() => {
		if (!view) return undefined;
		let created;
		let gone = false;
		try {
			created = type === "pdf" ? new PdfStripHost(view) : new DomStripHost(view);
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
	}, [view, type]);
	return host;
}

/**
 * Rendered once by ReaderUI. Draws nothing where it stands in the reader's
 * tree: the strip is drawn through portals into its own documents.
 */
export default function EvoNoteStrip(props) {
	const settings = props.state[NOTE_STRIP_STATE];
	const view = hasNoteStrip(props.type) && settings?.visible
		? window._reader?._primaryView || null
		: null;
	const host = useStripHost(view, props.type);
	if (!host || !settings?.visible) return null;
	return (
		<StripRoot
			host={host}
			state={props.state}
			settings={settings}
			paged={props.type === "pdf"}
			onUpdateAnnotations={props.onUpdateAnnotations}
			onSelectAnnotations={props.onSelectAnnotations}
			onOpenAnnotationContextMenu={props.onOpenAnnotationContextMenu}
			onNavigate={props.onNavigate}
		/>
	);
}
