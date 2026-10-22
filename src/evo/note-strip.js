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
import {
	NEUTRAL_PDF_FILTER, NOTE_STRIP_STATE, adoptPdfInfoFilter, applyNoteStrip, applyPdfFilter, hasNoteStrip, isNeutralPdfFilter, pdfFilterOf,
	reportNoteStrip, reportNoteStripAction, reportNoteStripOpen, reportPageInfo,
} from "../obsidian-evo";
import { PdfStripHost } from "./strip-host-pdf";
import { WHITE_MIN, contrastToSlider, sliderToContrast, sliderToWhite, whiteToSlider } from "./page-filter.mjs";
import { DomStripHost } from "./strip-host-dom";
import PdfEditPanel from "./pdf-edit-panel";
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
	onActivate, onDeactivate, onChange, onMeasure, onColor, onMenu, onLeave, onOpen,
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
			<span
				className={cx("zf-evo-page", { "is-link": !!onOpen && !annotation._draft })}
				aria-hidden="true"
				ref={pageRef}
				title={onOpen ? "Open at this place" : undefined}
				onClick={onOpen && !annotation._draft
					? (event) => {
						event.stopPropagation();
						onOpen(annotation);
					}
					: undefined}
			>{annotation.pageLabel || ""}</span>
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

/**
 * The authors on one line, fading out before the year when they do not fit.
 * With `authorList`, each name opens that person's note in Obsidian.
 */
function Byline({ authors, authorList, year, onPerson }) {
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
	}, [authors, authorList]);
	return (
		<div className="zf-evo-head-byline">
			<span ref={ref} className={cx("zf-evo-head-authors", { "is-overflowing": overflowing })} title={authors}>
				{authorList?.length
					? authorList.map((name, i) => (
						<React.Fragment key={i}>
							{i > 0 && ", "}
							<span className="zf-evo-person" onClick={event => onPerson?.(name, event)}>{name}</span>
						</React.Fragment>
					))
					: authors}
			</span>
			{year && <span className="zf-evo-head-year">{year}</span>}
		</div>
	);
}

/**
 * The two lines above the strip: the authors (all of them) with the year at
 * the right end, then the full title. `banner` is `{ authors, authorList,
 * year, title }` or just a text (shown as the title). A right-click on them
 * opens the plugin's menu (source note, library).
 */
function HeadBanner({ banner, onPerson, onMenu }) {
	if (!banner) return null;
	const { authors = "", authorList = null, year = "", title = "" } = typeof banner === "string" ? { title: banner } : banner;
	return (
		<div className="zf-evo-head-banner" onContextMenu={onMenu}>
			{(authors || year) && <Byline authors={authors} authorList={authorList} year={year} onPerson={onPerson}/>}
			{title && (
				<div className="zf-evo-head-title">
					{titleRuns(title).map((run, i) => (run.italic ? <i key={i}>{run.text}</i> : <React.Fragment key={i}>{run.text}</React.Fragment>))}
				</div>
			)}
		</div>
	);
}

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

/**
 * Lucide's chevrons-down-up (fold everything) and chevrons-up-down (unfold
 * everything): unlike the list toggle beside it.
 */
function IconFoldAll({ folded }) {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{folded
				? <><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></>
				: <><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></>}
		</svg>
	);
}

/** Lucide's file-cog: editing the PDF. */
function IconPdfEdit() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5"/>
			<path d="m3.2 12.9-.9-.4"/><path d="m3.2 15.1-.9.4"/><path d="m4.9 11.2-.4-.9"/><path d="m4.9 16.8-.4.9"/>
			<path d="m7.5 10.3-.4.9"/><path d="m7.5 17.7-.4-.9"/><path d="m9.7 12.5-.9.4"/><path d="m9.7 15.5-.9-.4"/>
			<circle cx="6" cy="14" r="3"/>
		</svg>
	);
}

/** Lucide's pencil: editing the item's data. */
function IconPencil() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>
		</svg>
	);
}

/**
 * The item's data editor, drawn by the plugin into this frame (the same
 * as in the library's item pane, with the abstract first).
 */
function ItemEditorHost() {
	const ref = useRef(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return undefined;
		let handle = null;
		try {
			handle = ObsidianBridge?.evoMountItemEditor?.(el) || null;
		}
		catch (e) {
			console.warn("[ZotFlow Evo] The item editor could not be shown:", e);
		}
		return () => {
			try {
				handle?.unload();
			}
			catch {
				// Gone with the plugin.
			}
		};
	}, []);
	return <div ref={ref} className="zf-evo-head-panel zf-evo-item-editor" onKeyDown={event => event.stopPropagation()}/>;
}

/** Lucide's sliders-horizontal: the page filter. */
function IconFilter() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/>
			<path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>
		</svg>
	);
}

/**
 * The page filter's sliders: KOReader's contrast (a gamma, 0.8 … 50, on a
 * logarithmic slider), white threshold (off at 255, more white to the
 * right) and saturation. See page-filter.mjs.
 */
const FILTER_SLIDERS = [
	{
		key: "contrast", label: "Contrast", max: 1000, step: 1,
		toSlider: contrastToSlider, fromSlider: sliderToContrast,
		format: v => (v < 10 ? v.toFixed(2) : v.toFixed(1)),
	},
	{
		key: "whiteThreshold", label: "White threshold", max: 255 - WHITE_MIN, step: 1,
		toSlider: whiteToSlider, fromSlider: sliderToWhite,
		format: v => (v >= 255 ? "Off" : String(v)),
	},
	{
		key: "saturation", label: "Saturation", max: 200, step: 1,
		toSlider: v => Math.round(v * 100), fromSlider: p => Math.round(p) / 100,
		format: v => `${Math.round(v * 100)}%`,
	},
];

/** The page filter's sliders, under the buttons (this PDF only). */
function FilterPanel({ filter, onChange, onClose }) {
	const f = pdfFilterOf(filter);
	return (
		<div className="zf-evo-head-panel zf-evo-filter-panel">
			{FILTER_SLIDERS.map(slider => (
				<label key={slider.key} className="zf-evo-slider">
					<span className="zf-evo-slider-label">{slider.label}</span>
					<input
						type="range"
						min={0}
						max={slider.max}
						step={slider.step}
						value={slider.toSlider(f[slider.key])}
						data-filter={slider.key}
						onChange={event => onChange({ ...f, [slider.key]: slider.fromSlider(Number(event.target.value)) })}
						onDoubleClick={() => onChange({ ...f, [slider.key]: NEUTRAL_PDF_FILTER[slider.key] })}
					/>
					<span className="zf-evo-slider-value">{slider.format(f[slider.key])}</span>
				</label>
			))}
			<div className="zf-evo-panel-buttons">
				<button
					type="button"
					className="zf-evo-panel-button"
					disabled={isNeutralPdfFilter(f)}
					onClick={() => onChange({ ...NEUTRAL_PDF_FILTER })}
				>
					Reset
				</button>
				<button type="button" className="zf-evo-panel-button" onClick={onClose}>
					Close
				</button>
			</div>
		</div>
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

function StripHead({
	host, annotations, settings, colors, paged, foldable, allFolded, readOnly, pageLabels,
	onToggleColor, onToggleHighlights, onAction, onFilter, onFoldAll,
}) {
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
	const [filterOpen, setFilterOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [itemOpen, setItemOpen] = useState(false);
	// The item's data: for a Zotero item, when the plugin offers it.
	const canEditItem = !readOnly && !ObsidianBridge?.isLocalReader?.() && typeof ObsidianBridge?.evoMountItemEditor === "function";
	// PDF editing: on a PDF in a reader, when it may be written.
	const canEdit = paged && !settings.stripOnly && !readOnly && !ObsidianBridge?.isLocalReader?.();
	const filtered = !isNeutralPdfFilter(settings.pdfFilter);
	const person = useCallback((name, event) => {
		event.stopPropagation();
		onAction("person:" + name, event);
	}, [onAction]);
	const menu = useCallback((event) => {
		event.preventDefault();
		onAction("title-menu", event);
	}, [onAction]);
	return (
		<div className={cx("zf-evo-head", { "is-pinned": filterOpen || editOpen || itemOpen })}>
			<HeadBanner banner={settings.banner} onPerson={person} onMenu={menu}/>
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
				{foldable && (
					<button
						type="button"
						className="zf-evo-tool"
						title={allFolded ? "Unfold all headings" : "Fold all headings"}
						aria-label={allFolded ? "Unfold all headings" : "Fold all headings"}
						data-tool="fold-all"
						onClick={onFoldAll}
					>
						<IconFoldAll folded={allFolded}/>
					</button>
				)}
				{paged && !settings.stripOnly && (
					<button
						type="button"
						className={cx("zf-evo-tool", { "is-on": filtered || filterOpen })}
						title="Page filter: white threshold, contrast, saturation"
						aria-pressed={filterOpen}
						aria-expanded={filterOpen}
						data-tool="page-filter"
						onClick={() => setFilterOpen(open => !open)}
					>
						<IconFilter/>
					</button>
				)}
				{canEditItem && (
					<button
						type="button"
						className={cx("zf-evo-tool", { "is-on": itemOpen })}
						title={itemOpen ? "Done editing" : "Edit the item's data and abstract"}
						aria-pressed={itemOpen}
						aria-expanded={itemOpen}
						data-tool="item-edit"
						onClick={() => setItemOpen(open => !open)}
					>
						<IconPencil/>
					</button>
				)}
				{canEdit && (
					<button
						type="button"
						className={cx("zf-evo-tool", { "is-on": editOpen })}
						title="Edit the PDF: split, straighten, outline, extract pages"
						aria-pressed={editOpen}
						aria-expanded={editOpen}
						data-tool="pdf-edit"
						onClick={() => setEditOpen(open => !open)}
					>
						<IconPdfEdit/>
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
			{canEditItem && itemOpen && <ItemEditorHost/>}
			{paged && !settings.stripOnly && filterOpen && (
				<FilterPanel filter={settings.pdfFilter} onChange={onFilter} onClose={() => setFilterOpen(false)}/>
			)}
			{canEdit && editOpen && (
				<PdfEditPanel
					view={host.view}
					pageLabels={pageLabels}
					filter={settings.pdfFilter}
					onClose={() => setEditOpen(false)}
				/>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------ */

function Strip({
	host, state, settings, colors, actions, paged, folded, onFold, onFoldable,
	onUpdateAnnotations, onSelectAnnotations, onOpenAnnotationContextMenu, onNavigate,
}) {
	const reader = window._reader;
	// Beside a snapshot the strip is a list, whatever is set for PDFs.
	const collapsed = !!settings.collapsed || !host.canAnchor;
	const showHighlights = !!settings.highlights;
	const readOnly = !!state.readOnly;
	// The strip alone, in a tab of its own: no page beside it to go to.
	const stripOnly = !!settings.stripOnly;
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
	// How the entries look (the plugin's settings): quotes round what was
	// marked, its text a little faint, the room between entries.
	const look = settings.appearance || {};
	const spacing = Number.isFinite(look.spacing) ? Math.max(4, Math.min(48, look.spacing)) : 12;
	const highlightOpacity = Number.isFinite(look.highlightOpacity) ? Math.max(0.3, Math.min(1, look.highlightOpacity)) : 1;
	useEffect(() => {
		const root = host.stripDoc.documentElement;
		root.style.setProperty("--zf-evo-entry-gap", `${spacing}px`);
		root.style.setProperty("--zf-evo-highlight-opacity", String(highlightOpacity));
		host.stripDoc.body?.classList.toggle("zf-evo-quotes", !!look.quotes);
	}, [host, spacing, highlightOpacity, look.quotes]);
	useEffect(() => {
		host.setCollapsed(collapsed);
	}, [host, collapsed]);

	useEffect(() => host.on((event) => {
		if (event.type === "geometry") bump();
		else if (event.type === "resized") {
			// Dragged wider or narrower: kept by the plugin, for every reader.
			reportNoteStrip(reader, { width: event.width });
		}
		else if (event.type === "scroll") setScrollSlot(Math.floor(host.scrollTop / SCROLL_STEP));
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

	// As a list, the strip scrolls by itself: bring the opened entry into
	// view; one just made (not there before) goes to the top of the strip.
	const knownIds = useRef(null);
	useEffect(() => {
		if (!activeId || !collapsed) return;
		const el = host.stripDoc.querySelector(`[data-entry-id="${CSS.escape(activeId)}"]`);
		const isNew = knownIds.current && !knownIds.current.has(activeId);
		el?.scrollIntoView({ block: isNew ? "start" : "nearest" });
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
		// The strip alone: Ctrl/Cmd+click opens the place in a reader.
		if (stripOnly && (event?.ctrlKey || event?.metaKey)) {
			reportNoteStripOpen({ annotationID: annotation.id });
			return;
		}
		if (draftRef.current) endDraft();
		// Anchored, the annotation is already beside its entry; as a list the
		// page is brought to it.
		onSelectAnnotations([annotation.id], !collapsed, event);
		if (readOnly || annotation.readOnly) return;
		activate(annotation.id);
	}, [activate, collapsed, endDraft, onSelectAnnotations, readOnly, stripOnly]);

	const handleOpen = useCallback((annotation) => {
		reportNoteStripOpen({ annotationID: annotation.id });
	}, []);

	const handleMenu = useCallback((annotation, event) => {
		const { x, y } = host.toReaderPoint(event.clientX, event.clientY);
		onOpenAnnotationContextMenu({ ids: [annotation.id], currentID: annotation.id, x, y });
	}, [host, onOpenAnnotationContextMenu]);

	const handleLeave = useCallback(() => host.focusView(), [host]);

	const handleHeading = useCallback((heading) => {
		if (stripOnly) reportNoteStripOpen(heading.location);
		else onNavigate(heading.location);
	}, [onNavigate, stripOnly]);

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
		if (collapsed) {
			// The headings that can be folded (the head's fold-all button).
			const foldable = foldEntries(entries, new Set())
				.filter(entry => entry.kind === "heading" && entry.hasContent)
				.map(entry => entry.id);
			return { entries: foldEntries(entries, folded), placed: null, any, foldable };
		}
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
		// The room between entries beyond the usual (12 px in a list) also
		// keeps anchored entries apart.
		return { entries: items, placed: layoutCards(items, { gap: Math.max(0, spacing - 12) }), any };
		// `tick` stands for what the host measures (page positions, zoom, page
		// texts) and for the heights in `heights`, none of which React sees.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [annotations, headings, activeId, draft, collapsed, showHighlights, colors, folded, tick, host, spacing]);

	// What the head's fold-all button folds (list only).
	const foldableKey = (model.foldable || []).join("|");
	useEffect(() => {
		onFoldable(model.foldable || []);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [foldableKey, onFoldable]);

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
		// "What is being read" is nowhere in sight when the strip is alone.
		else if (!stripOnly) startNoteHere();
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

	// The entries there now, for telling a new one (after the effect above).
	useEffect(() => {
		knownIds.current = new Set(model.entries.map(x => x.id));
	}, [model]);

	// As a list, room after the last entry: it can be scrolled to the top.
	const last = collapsed && visible.length ? visible[visible.length - 1] : null;

	// Anchored, with no comment in view: arrows at the top and the bottom
	// with the page of the nearest comment that way (strip-host-pdf.js).
	useEffect(() => {
		if (collapsed) {
			host.setArrows(null, null);
			return undefined;
		}
		let targets = null;
		const update = () => {
			targets = arrowTargets(model.entries, model.placed, host.viewTop, host.scrollTop + host.clientHeight);
			host.setArrows(
				targets?.up ? targets.up.annotation.pageLabel ?? "" : null,
				targets?.down ? targets.down.annotation.pageLabel ?? "" : null,
			);
		};
		update();
		const off = host.on((event) => {
			if (event.type === "scroll" || event.type === "geometry") update();
			// A click on an arrow: to that comment.
			else if (event.type === "arrow") {
				const target = targets?.[event.dir];
				if (target) onNavigate({ annotationID: target.annotation.id });
			}
		});
		return () => {
			off();
			host.setArrows(null, null);
		};
	}, [host, model, collapsed, onNavigate]);

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
						onOpen={stripOnly ? handleOpen : undefined}
					/>
				)))}
			{last && <ListTail lastId={last.id}/>}
			{nothing && (
				<div className="zf-evo-empty">
					{colors.size
						? "Nothing in this colour."
						: readOnly || stripOnly
							? "No comments."
							: `No comments yet. Click here to write a note${paged ? " for this page" : ""}.`}
				</div>
			)}
		</div>
	);
}

/**
 * Room after the last entry of the list, so it can be scrolled to the top
 * with only space after it: as high as the strip's view less the entry
 * (measured as drawn, margin included), kept so as both change.
 */
function ListTail({ lastId }) {
	const ref = useRef(null);
	useLayoutEffect(() => {
		const tail = ref.current;
		if (!tail) return undefined;
		const doc = tail.ownerDocument;
		const win = doc.defaultView;
		const fit = () => {
			const last = tail.previousElementSibling;
			if (!last) return;
			const style = win.getComputedStyle(last);
			// The strip's own room below (a click there starts a note) counts too.
			const below = parseFloat(win.getComputedStyle(tail.parentElement).paddingBottom || "0");
			const used = last.getBoundingClientRect().height + parseFloat(style.marginBottom || "0") + below;
			tail.style.height = Math.max(0, doc.body.clientHeight - used) + "px";
		};
		fit();
		const observer = new win.ResizeObserver(fit);
		observer.observe(doc.body);
		const last = tail.previousElementSibling;
		if (last) observer.observe(last);
		return () => observer.disconnect();
	}, [lastId]);
	return <div ref={ref} className="zf-evo-tail" aria-hidden="true"/>;
}

/** The head and the strip, which share the colour filter. */
function StripRoot({ host, state, settings, paged, ...handlers }) {
	const [colors, setColors] = useState(() => new Set());
	// Outline headings folded away (list only), for this document.
	const [folded, setFolded] = useState(() => new Set());
	// The headings that can be folded at all (reported by the strip).
	const [foldable, setFoldable] = useState([]);
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

	const reportFoldable = useCallback((ids) => {
		setFoldable(current => (current.join("|") === ids.join("|") ? current : ids));
	}, []);
	// Everything folded: unfold everything; otherwise fold everything.
	const allFolded = foldable.length > 0 && foldable.every(id => folded.has(id));
	const foldAll = useCallback(() => {
		fold(foldable, !allFolded);
	}, [fold, foldable, allFolded]);

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

	// The page filter follows the sliders at once; the plugin keeps it (for
	// every reader) once they rest.
	const filterTimer = useRef(null);
	const changeFilter = useCallback((filter) => {
		const reader = window._reader;
		applyNoteStrip(reader, { pdfFilter: filter });
		if (filterTimer.current) clearTimeout(filterTimer.current);
		filterTimer.current = setTimeout(() => {
			filterTimer.current = null;
			reportNoteStrip(reader, { pdfFilter: filter });
		}, 300);
	}, []);

	const viewAction = useCallback((id, event) => {
		const { x, y } = host.toTopPoint(host.head, event.clientX, event.clientY);
		reportNoteStripAction(id, x, y);
	}, [host]);

	return (
		<>
			{createPortal(
				<StripHead
					host={host}
					annotations={state.annotations}
					settings={settings}
					colors={colors}
					paged={paged}
					onToggleColor={toggleColor}
					onToggleHighlights={toggleHighlights}
					onAction={viewAction}
					onFilter={changeFilter}
					foldable={foldable.length > 0}
					allFolded={allFolded}
					onFoldAll={foldAll}
					readOnly={!!state.readOnly}
					pageLabels={state.pageLabels}
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
					onFoldable={reportFoldable}
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
	// The page filter is on the pages whether the strip is shown or not; a
	// view (re)drawn gets it again (cheap when nothing changed).
	const filterKey = JSON.stringify(settings?.pdfFilter ?? null);
	const stats = props.state.primaryViewStats;
	useEffect(() => {
		if (props.type !== "pdf") return;
		applyPdfFilter(window._reader);
		// A filter written into this PDF, when none is kept for it.
		if (stats?.pagesCount) adoptPdfInfoFilter(window._reader);
	}, [filterKey, stats, props.type]);
	const view = hasNoteStrip(props.type) && settings?.visible
		? window._reader?._primaryView || null
		: null;
	const host = useStripHost(view, props.type);
	const stripOnly = !!settings?.stripOnly;
	useEffect(() => {
		host?.setStripOnly(stripOnly);
	}, [host, stripOnly]);
	// The page being read: beside the strip, and to the plugin (which shows
	// it in the view's header while the strip is hidden).
	const pageInfo = stats && Number.isInteger(stats.pageIndex) && stats.pagesCount
		? { label: stats.pageLabel ?? String(stats.pageIndex + 1), index: stats.pageIndex, count: stats.pagesCount }
		: null;
	const pageKey = pageInfo ? `${pageInfo.label}|${pageInfo.index}|${pageInfo.count}` : "";
	useEffect(() => {
		host?.setPageInfo(pageInfo);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [host, pageKey]);
	useEffect(() => {
		if (pageInfo && !stripOnly) reportPageInfo(pageInfo);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pageKey, stripOnly]);
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
