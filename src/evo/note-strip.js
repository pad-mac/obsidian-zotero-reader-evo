/**
 * ZotFlow Evo — the note strip: the comments of a PDF, beside the pages.
 *
 * Rendered by the reader's React tree (one line in reader-ui.js) into the
 * strip's own document, which `strip-host.js` creates inside the PDF view
 * and keeps level with the pages. Where each comment goes is decided in
 * `strip-layout.mjs`.
 *
 * What the strip shows is what Zotero stores:
 *  - the comment of a highlight (or underline, image, ink) — one bar in the
 *    annotation's colour;
 *  - a note annotation, i.e. a comment placed on the page — two bars.
 * A highlight without a comment appears only while it is selected.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import cx from "classnames";
import { ObsidianBridge } from "../obsidian-adapter";
import { ANNOTATION_COLORS } from "../common/defines";
import { NOTE_STRIP_STATE } from "../obsidian-evo";
import { EvoStripHost } from "./strip-host";
import { estimateHeight, layoutCards } from "./strip-layout.mjs";

/** Comments this far above and below the visible part are rendered too. */
const OVERSCAN = 1500;

/** The set of rendered comments is reconsidered every this many pixels of scrolling. */
const SCROLL_STEP = 400;

/** Wait for the click that selected an annotation to finish before taking the focus. */
const FOCUS_DELAY = 60;

const WITH_COMMENT = new Set(["highlight", "underline", "note", "image", "ink"]);
const DEFAULT_NOTE_COLOR = ANNOTATION_COLORS[0][1];

function isShown(annotation, activeId) {
	if (annotation._hidden || !WITH_COMMENT.has(annotation.type)) return false;
	return annotation.type === "note" || !!annotation.comment || annotation.id === activeId;
}

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

function StripEditor({ id, text, focusToken, onChange, onEscape }) {
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
		const timer = win.setTimeout(() => focusEditor(editorRef.current, win), FOCUS_DELAY);
		return () => win.clearTimeout(timer);
	}, [focusToken, id]);

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
 * One comment
 * ------------------------------------------------------------------ */

function Card({
	annotation, place, active, list, focusToken, readOnly,
	onActivate, onDeactivate, onChange, onMeasure, onColor, onMenu, onLeave,
}) {
	const rootRef = useRef();
	const innerRef = useRef();
	const isNote = annotation.type === "note";
	const editable = active && !readOnly && !annotation.readOnly;

	useLayoutEffect(() => {
		const inner = innerRef.current;
		const report = () => onMeasure(annotation.id, inner.offsetHeight);
		report();
		const observer = new inner.ownerDocument.defaultView.ResizeObserver(report);
		observer.observe(inner);
		return () => observer.disconnect();
	}, [annotation.id, onMeasure]);

	function handleBlur(event) {
		if (!active) return;
		const root = rootRef.current;
		if (event.relatedTarget && root.contains(event.relatedTarget)) return;
		const doc = root.ownerDocument;
		// After the focus has settled: it may only have moved within the comment.
		doc.defaultView.setTimeout(() => {
			if (!root.isConnected || !doc.hasFocus() || !root.contains(doc.activeElement)) {
				onDeactivate(annotation.id);
			}
		}, 0);
	}

	function handleClick(event) {
		if (active) return;
		onActivate(annotation, event);
	}

	function handleDragStart(event) {
		if (annotation._draft || active) {
			event.preventDefault();
			return;
		}
		event.dataTransfer.effectAllowed = "copy";
		// The same payload a dragged annotation carries, marked as a comment
		// so the plugin formats the drop with the comment templates.
		ObsidianBridge.handleSetDataTransferAnnotations(
			event.dataTransfer, [annotation], false, { evoSource: "comment" }
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
				"is-note": isNote,
				"is-active": active,
				"is-clamped": !active && !list && place?.clamped,
			})}
			style={style}
			data-annotation-id={annotation._draft ? undefined : annotation.id}
			draggable={!active && !annotation._draft}
			onClick={handleClick}
			onBlur={handleBlur}
			onDragStart={handleDragStart}
			onContextMenu={handleContextMenu}
		>
			<span className="zf-evo-bars" aria-hidden="true">
				<span className="zf-evo-bar"/>
				{isNote && <span className="zf-evo-bar"/>}
			</span>
			<span className="zf-evo-page" aria-hidden="true">{annotation.pageLabel || ""}</span>
			<div className="zf-evo-card-clip">
				<div className="zf-evo-card-inner" ref={innerRef}>
					{editable
						? (
							<StripEditor
								id={annotation.id}
								text={annotation.comment}
								focusToken={focusToken}
								onChange={text => onChange(annotation.id, text)}
								onEscape={onLeave}
							/>
						)
						: <StripPreview text={annotation.comment} lazy={list}/>}
					{editable && isNote && (
						<div className="zf-evo-palette" role="group" aria-label="Note colour">
							{ANNOTATION_COLORS.map(([name, color]) => (
								<button
									key={color}
									type="button"
									className={cx("zf-evo-swatch", { "is-current": color === annotation.color })}
									style={{ "--zf-evo-color": color }}
									title={name.replace("general-", "")}
									onClick={() => onColor(annotation.id, color)}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------ */

function Strip({ host, state, settings, onUpdateAnnotations, onSelectAnnotations, onOpenAnnotationContextMenu }) {
	const reader = window._reader;
	const collapsed = !!settings.collapsed;
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
	useEffect(() => {
		host.setBanner(settings.banner);
	}, [host, settings.banner]);

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

	// Selecting an annotation on the page opens its line in the strip.
	const selected = state.selectedAnnotationIDs;
	useEffect(() => {
		if (selected.length === 1) {
			const id = selected[0];
			if (id === activeRef.current || id === draftRef.current?.createdId) return;
			const annotation = reader._state.annotations.find(x => x.id === id);
			if (!annotation || !WITH_COMMENT.has(annotation.type)) return;
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

	// The strip does not scroll by itself, so the pages are scrolled to keep
	// the cursor of the open comment in view.
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
				rect = { top: all.bottom - 20, bottom: all.bottom };
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
		noteColor.current = color;
		const current = draftRef.current;
		if (current && current.id === id) {
			if (current.createdId) onUpdateAnnotations([{ id: current.createdId, color }]);
			setDraft({ ...current, color });
			return;
		}
		onUpdateAnnotations([{ id, color }]);
	}, [onUpdateAnnotations]);

	const handleActivate = useCallback((annotation, event) => {
		if (annotation._draft) return;
		if (draftRef.current) endDraft();
		// Anchored, the annotation is already beside its comment; in the list
		// the page is brought to it.
		onSelectAnnotations([annotation.id], !collapsed, event);
		activate(annotation.id);
	}, [activate, collapsed, endDraft, onSelectAnnotations]);

	const handleMenu = useCallback((annotation, event) => {
		const { x, y } = host.toReaderPoint(event.clientX, event.clientY);
		onOpenAnnotationContextMenu({ ids: [annotation.id], currentID: annotation.id, x, y });
	}, [host, onOpenAnnotationContextMenu]);

	const handleLeave = useCallback(() => host.focusView(), [host]);

	// A click on an empty line starts a note there.
	function handleStripClick(event) {
		if (event.target !== event.currentTarget || collapsed || readOnly) return;
		const spot = host.spotAt(event.clientY);
		if (!spot) return;
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
	}

	const annotations = state.annotations;
	const model = useMemo(() => {
		const items = [];
		const pages = new Map();
		for (const annotation of annotations) {
			if (!isShown(annotation, activeId)) continue;
			// While a note is being typed its card is the draft's.
			if (draft?.createdId === annotation.id) continue;
			const anchor = collapsed ? 0 : host.anchorOf(annotation, pages);
			if (anchor === null) continue;
			items.push({ id: annotation.id, annotation, anchor });
		}
		if (draft) items.push({ id: draft.id, annotation: draft, anchor: collapsed ? 0 : draft.anchor });
		items.sort((a, b) => a.anchor - b.anchor
			|| (a.annotation.sortIndex || "").localeCompare(b.annotation.sortIndex || ""));
		for (const item of items) {
			item.natural = heights.current.get(item.id)
				?? estimateHeight(item.annotation.comment, host.width);
		}
		return { items, placed: collapsed ? null : layoutCards(items) };
		// `tick` stands for what the host measures (page positions, zoom) and
		// for the comment heights in `heights`, neither of which React sees.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [annotations, activeId, draft, collapsed, tick, host]);

	// Only the comments near the visible part are rendered. `scrollSlot`
	// changes every SCROLL_STEP pixels of scrolling, which is when the set is
	// looked at again.
	const visible = useMemo(() => {
		if (collapsed) return model.items;
		const from = host.scrollTop - OVERSCAN;
		const to = host.scrollTop + host.clientHeight + OVERSCAN;
		return model.items.filter((item) => {
			if (item.id === activeId) return true;
			const place = model.placed.get(item.id);
			return place.top + Math.max(place.height, item.natural) >= from && place.top <= to;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- scrollSlot is the trigger
	}, [model, collapsed, activeId, host, scrollSlot]);

	return (
		<div
			className={cx("zf-evo-strip", { "is-list": collapsed, "is-read-only": readOnly })}
			style={collapsed ? undefined : { height: host.contentHeight }}
			onClick={handleStripClick}
		>
			{collapsed && !visible.length && <div className="zf-evo-empty">No comments yet</div>}
			{visible.map(item => (
				<Card
					key={item.id}
					annotation={item.annotation}
					place={model.placed?.get(item.id)}
					active={item.id === activeId}
					list={collapsed}
					focusToken={item.id === activeId ? focusToken : 0}
					readOnly={readOnly}
					onActivate={handleActivate}
					onDeactivate={deactivate}
					onChange={handleChange}
					onMeasure={handleMeasure}
					onColor={handleColor}
					onMenu={handleMenu}
					onLeave={handleLeave}
				/>
			))}
		</div>
	);
}

function useStripHost(view) {
	const [host, setHost] = useState(null);
	useEffect(() => {
		if (!view?._iframeWindow?.document?.getElementById("viewerContainer")) {
			return undefined;
		}
		let created;
		let gone = false;
		try {
			created = new EvoStripHost(view);
			created.setVisible(true);
		}
		catch (e) {
			console.error("[ZotFlow Evo] The note strip could not start:", e);
			created?.destroy();
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
 * the strip is a portal into its document inside the PDF view.
 */
export default function EvoNoteStrip(props) {
	const settings = props.state[NOTE_STRIP_STATE];
	const view = props.type === "pdf" && settings?.visible
		? window._reader?._primaryView || null
		: null;
	const host = useStripHost(view);
	if (!host || !settings?.visible) return null;
	return createPortal(
		<Strip
			host={host}
			state={props.state}
			settings={settings}
			onUpdateAnnotations={props.onUpdateAnnotations}
			onSelectAnnotations={props.onSelectAnnotations}
			onOpenAnnotationContextMenu={props.onOpenAnnotationContextMenu}
		/>,
		host.mount
	);
}
