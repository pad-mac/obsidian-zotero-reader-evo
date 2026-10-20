/**
 * ZotFlow Evo — the note strip's frames, whatever they stand beside.
 *
 * The strip is drawn in documents of its own: a pinned head (title line,
 * buttons, colour filters) and the strip itself, each an iframe.
 *
 *   #zf-evo-strip-column
 *   ├─ iframe#zf-evo-strip-head
 *   └─ .zf-evo-clip
 *      └─ iframe#zf-evo-strip-frame
 *
 * A document of its own keeps the strip's keys, clicks and drags away from
 * whatever listens around it (the PDF view listens on its whole window), and
 * gives Obsidian's editor a document that is not the page's.
 *
 * Where the column stands, and what a place in the document is, differs:
 *  - strip-host-pdf.js: inside the PDF view, level with the pages;
 *  - strip-host-dom.js: beside a snapshot, as a list.
 * The strip's content is rendered into the frames by the reader's own React
 * tree (note-strip.js).
 */

import { STRIP_ONLY_CLASS, followTheme, unfollowTheme } from "../obsidian-evo";

export const COLUMN_ID = "zf-evo-strip-column";
export const FRAME_ID = "zf-evo-strip-frame";
export const HEAD_ID = "zf-evo-strip-head";

/** Class on the root of the strip's documents; `_evo.scss` keys the strip's styles off it. */
export const STRIP_DOC_CLASS = "zf-evo-strip-doc";

/** Added on the root of the head's document. */
export const STRIP_HEAD_CLASS = "zf-evo-strip-head";

/** On the body of both documents while the pointer is over the strip: the head's buttons show. */
export const HOVER_CLASS = "zf-evo-hover";

/** How long the buttons stay after the pointer left (it may be crossing from head to strip). */
const HOVER_LINGER = 250;

function isTextBox(target) {
	return !!target?.closest?.("textarea, input, [contenteditable=''], [contenteditable='true'], .cm-content");
}

function rulesText(sheet) {
	try {
		return Array.from(sheet.cssRules, rule => rule.cssText).join("\n");
	}
	catch {
		return "";
	}
}

/**
 * Give the strip document the reader document's styles: its stylesheet (the
 * themes, the comment editor, the strip itself) and the copy of Obsidian's
 * app.css the reader adopted. Constructed stylesheets cannot be shared
 * between documents, so they are rebuilt from their rules.
 */
function copyStyles(from, to) {
	for (const sheet of Array.from(from.styleSheets)) {
		// The variables overlay is written per document (obsidian-evo.js).
		if (sheet.ownerNode?.id === "zf-evo-resolved-vars") continue;
		const text = rulesText(sheet);
		if (!text) continue;
		const style = to.createElement("style");
		style.textContent = text;
		to.head.appendChild(style);
	}
	const Sheet = to.defaultView?.CSSStyleSheet;
	if (!Sheet || !from.adoptedStyleSheets?.length) return;
	const adopted = [];
	for (const sheet of from.adoptedStyleSheets) {
		try {
			const copy = new Sheet();
			copy.replaceSync(rulesText(sheet));
			adopted.push(copy);
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not copy a stylesheet into the note strip:", e);
		}
	}
	to.adoptedStyleSheets = adopted;
}

/** The strip's width in pixels, as it may be set or dragged. */
export const MIN_WIDTH = 160;
export const MAX_WIDTH = 900;

function clampWidth(width) {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width) || 320));
}

/**
 * The frames, and what does not depend on where they stand. A subclass puts
 * the column somewhere (`_build(parent)`) and answers for places in its
 * document. Made for one view of the reader (`reader._primaryView`).
 */
export class StripHost {
	constructor(view) {
		this.view = view;
		this.win = view?._iframeWindow;
		this.doc = this.win?.document;
		if (!this.doc?.body) {
			throw new Error("The view's document is not ready");
		}
		this._listeners = new Set();
		this._collapsed = !this.canAnchor;
		this._visible = false;
		this._destroyed = false;
		this._headHeight = 0;
	}

	/** Whether entries can be shown beside their place in the document (otherwise: a list only). */
	get canAnchor() {
		return false;
	}

	/**
	 * Create the column in `parent` and open the strip's documents.
	 *
	 * @param {Element} parent
	 * @param {(() => string) | null} surface The colour behind the strip, if
	 *   it is not the reader's own.
	 */
	_build(parent, surface = null) {
		const hostDoc = parent.ownerDocument;
		this.column = hostDoc.createElement("div");
		this.column.id = COLUMN_ID;
		this.head = hostDoc.createElement("iframe");
		this.head.id = HEAD_ID;
		this.head.setAttribute("tabindex", "-1");
		this.head.setAttribute("title", "Notes: filters");
		this.clip = hostDoc.createElement("div");
		this.clip.className = "zf-evo-clip";
		this.frame = hostDoc.createElement("iframe");
		this.frame.id = FRAME_ID;
		this.frame.setAttribute("tabindex", "-1");
		this.frame.setAttribute("title", "Notes");
		this.clip.appendChild(this.frame);
		this.column.append(this.head, this.clip);
		parent.appendChild(this.column);

		// Documents of their own, in standards mode, styled and themed like
		// the reader's.
		const openDocument = (frame, ownClass) => {
			const frameDoc = frame.contentDocument;
			frameDoc.open();
			frameDoc.write("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
			frameDoc.close();
			copyStyles(document, frameDoc);
			followTheme(frameDoc, ownClass, surface && (() => {
				const color = surface();
				if (color) frameDoc.documentElement.style.setProperty("--zf-evo-surface", color);
				else frameDoc.documentElement.style.removeProperty("--zf-evo-surface");
			}));
			return frameDoc;
		};
		const stripDoc = openDocument(this.frame, STRIP_DOC_CLASS);
		this.stripDoc = stripDoc;
		this.stripWin = this.frame.contentWindow;
		this.headDoc = openDocument(this.head, `${STRIP_DOC_CLASS} ${STRIP_HEAD_CLASS}`);
		this.headWin = this.head.contentWindow;

		// React renders the head into this node (note-strip.js). The head's
		// frame is as tall as what is in it.
		this.headMount = this.headDoc.createElement("div");
		this.headMount.className = "zf-evo-head-root";
		this.headDoc.body.appendChild(this.headMount);
		this._headObserver = new this.headWin.ResizeObserver(() => {
			const height = Math.ceil(this.headMount.getBoundingClientRect().height);
			if (height === this._headHeight) return;
			this._headHeight = height;
			this.column.style.setProperty("--zf-evo-head-height", height + "px");
			this._geometryChanged();
		});
		this._headObserver.observe(this.headMount);

		// Obsidian's editor and renderer expect its DOM helpers (createDiv,
		// addClass, …) in whatever window they work in, as in one of its own
		// pop-out windows. The reader's document loads them from Obsidian's
		// enhance.js; the strip's document does the same.
		this.ready = new Promise((resolve) => {
			try {
				const script = stripDoc.createElement("script");
				script.onload = script.onerror = () => resolve();
				script.src = new URL("enhance.js", document.baseURI).href;
				stripDoc.head.appendChild(script);
				this.stripWin.setTimeout(resolve, 2000);
			}
			catch (e) {
				console.warn("[ZotFlow Evo] Obsidian's DOM helpers are not available in the note strip:", e);
				resolve();
			}
		});

		// React renders the strip into this node (note-strip.js).
		this.mount = stripDoc.createElement("div");
		this.mount.className = "zf-evo-strip-root";
		stripDoc.body.appendChild(this.mount);

		// The edge towards the document can be dragged to make the strip
		// wider or narrower. In both documents, so it runs the full height.
		for (const doc of [this.headDoc, stripDoc]) this._addResizeHandle(doc);

		this._onKey = this._onKey.bind(this);
		for (const win of [this.stripWin, this.headWin]) {
			win.addEventListener("keydown", this._onKey);
			win.addEventListener("keyup", this._onKey);
		}
		// Whether a mouse button is held on the document, and whether that
		// press turned into a drag (see afterPointer()). Chrome ends the
		// pointer events when a drag starts, so the end of the drag counts too.
		this._pointerDown = false;
		this._dragged = false;
		this._pointerWaiters = [];
		this._onPointerDown = () => {
			this._pointerDown = true;
			this._dragged = false;
		};
		this._onDragStart = () => {
			this._dragged = true;
		};
		const pointerEnded = () => {
			if (!this._pointerDown) return;
			this._pointerDown = false;
			const waiters = this._pointerWaiters;
			this._pointerWaiters = [];
			for (const waiter of waiters) waiter(this._dragged);
		};
		this._onPointerEnd = (event) => {
			if (event.type !== "pointercancel") {
				pointerEnded();
				return;
			}
			// A starting drag cancels the pointer; that is not the end of
			// the press. Whichever of the two events comes first, the drag
			// is known a moment later.
			this.win.setTimeout(() => {
				if (!this._dragged) pointerEnded();
			}, 50);
		};
		this.win.addEventListener("pointerdown", this._onPointerDown, true);
		this.win.addEventListener("dragstart", this._onDragStart, true);
		for (const type of ["pointerup", "pointercancel", "dragend"]) {
			this.win.addEventListener(type, this._onPointerEnd, true);
		}

		this._trackHover();
		this._applyMode();
	}

	/**
	 * The head's buttons and filters show only while the pointer is over
	 * the strip, head or comments (HOVER_CLASS). Each is a document of its
	 * own, so both are watched; a short linger covers the crossing.
	 */
	_trackHover() {
		this._hovered = false;
		this._hoverTimer = null;
		const apply = (on) => {
			if (on === this._hovered) return;
			this._hovered = on;
			// On the body: the root's classes are the reader document's (followTheme).
			for (const doc of [this.headDoc, this.stripDoc]) {
				doc.body?.classList.toggle(HOVER_CLASS, on);
			}
			// And on the document the strip sits in (the page numbers beside it).
			this.doc.documentElement.classList.toggle("zf-evo-strip-hovered", on);
			this._emit("hover", { on });
		};
		const enter = () => {
			if (this._hoverTimer !== null) {
				this.win.clearTimeout(this._hoverTimer);
				this._hoverTimer = null;
			}
			apply(true);
		};
		const leave = () => {
			if (this._hoverTimer !== null) this.win.clearTimeout(this._hoverTimer);
			this._hoverTimer = this.win.setTimeout(() => {
				this._hoverTimer = null;
				apply(false);
			}, HOVER_LINGER);
		};
		for (const doc of [this.headDoc, this.stripDoc]) {
			const root = doc.documentElement;
			root.addEventListener("pointerenter", enter);
			root.addEventListener("pointerleave", leave);
			// An enter missed (the strip appeared under the pointer).
			doc.addEventListener("pointermove", () => {
				if (!this._hovered || this._hoverTimer !== null) enter();
			}, { passive: true });
		}
	}

	/**
	 * A point in one of the strip's documents (`frame`: its iframe), in the
	 * reader's document: through the frames it stands in.
	 */
	toTopPoint(frame, clientX, clientY) {
		let x = clientX;
		let y = clientY;
		let el = frame;
		while (el) {
			const rect = el.getBoundingClientRect();
			x += rect.left;
			y += rect.top;
			const win = el.ownerDocument.defaultView;
			if (!win || win === window) break;
			el = win.frameElement;
		}
		return { x, y };
	}

	/**
	 * Anchored, with no comment in view: the page labels of the nearest
	 * comment above and below (null: none that way), for the arrows. Only
	 * where entries can be anchored.
	 */
	// eslint-disable-next-line no-unused-vars
	setArrows(up, down) {}

	/**
	 * The page being read, beside the strip: its label and its number of
	 * the whole (`{ label, index, count }`). Only beside pages.
	 */
	// eslint-disable-next-line no-unused-vars
	setPageInfo(info) {}

	/**
	 * Call `run` once no mouse button is held on the document: at once, or
	 * when the press ends. It is told whether the press became a drag. Taking
	 * the keyboard focus while an annotation is being pressed or dragged would
	 * get in the way of the drag.
	 * @returns {() => void} Call to give up waiting.
	 */
	afterPointer(run) {
		if (!this._pointerDown) {
			run(false);
			return () => {};
		}
		this._pointerWaiters.push(run);
		return () => {
			this._pointerWaiters = this._pointerWaiters.filter(x => x !== run);
		};
	}

	/**
	 * @param {(event: { type: "geometry" | "scroll" | "resized", width?: number }) => void} listener
	 *   "resized": the strip was dragged to `width` (and let go).
	 */
	on(listener) {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	_emit(type, extra = null) {
		for (const listener of this._listeners) listener({ type, ...extra });
	}

	get collapsed() {
		return this._collapsed;
	}

	setVisible(visible) {
		visible = !!visible;
		if (visible === this._visible) return;
		this._visible = visible;
		this._showColumn(visible);
		this._geometryChanged();
	}

	setWidth(width) {
		const px = clampWidth(width);
		if (px === this._width) return;
		this._width = px;
		this._applyWidth(px);
		if (this._visible) this._geometryChanged();
	}

	get width() {
		return this._width || 320;
	}

	/** Whether the strip stands at the right of the document (else at the left: right-to-left text). */
	get stripOnRight() {
		return true;
	}

	/**
	 * A handle along the edge of the strip towards the document. While it is
	 * dragged only the strip's width changes (`_applyWidth(px, true)`); the
	 * document is fitted to it, and listeners hear "resized", when it is let
	 * go. Positions are screen positions: the frame moves under the pointer.
	 */
	_addResizeHandle(doc) {
		const handle = doc.createElement("div");
		handle.className = "zf-evo-resize";
		handle.setAttribute("aria-hidden", "true");
		handle.title = "Drag to resize";
		doc.body.appendChild(handle);
		handle.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			try {
				handle.setPointerCapture(event.pointerId);
			}
			catch {
				// Moves outside the frame are then not followed.
			}
			const startX = event.screenX;
			const startWidth = this.width;
			const sign = this.stripOnRight ? 1 : -1;
			let width = startWidth;
			handle.classList.add("is-dragging");
			const move = (ev) => {
				width = clampWidth(startWidth + sign * (startX - ev.screenX));
				this._applyWidth(width, true);
			};
			const end = () => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", end);
				handle.removeEventListener("pointercancel", end);
				handle.classList.remove("is-dragging");
				if (width === startWidth) {
					this._applyWidth(startWidth, true);
					return;
				}
				this.setWidth(width);
				this._emit("resized", { width });
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		});
	}

	/** As a list (true), or every entry beside its place (false; only where `canAnchor`). */
	setCollapsed(collapsed) {
		collapsed = !!collapsed || !this.canAnchor;
		if (collapsed === this._collapsed) return;
		this._collapsed = collapsed;
		this._applyMode();
		this._emit("geometry");
	}

	/**
	 * The strip alone, the document out of sight (strip-only). Marked on the
	 * strip's documents; a subclass marks its own document too.
	 */
	setStripOnly(on) {
		on = !!on;
		if (on === this._stripOnly) return;
		this._stripOnly = on;
		for (const doc of [this.headDoc, this.stripDoc]) {
			doc?.body?.classList.toggle(STRIP_ONLY_CLASS, on);
		}
		this._applyStripOnly(on);
		this._geometryChanged();
	}

	get stripOnly() {
		return !!this._stripOnly;
	}

	// eslint-disable-next-line no-unused-vars
	_applyStripOnly(on) {}

	_applyMode() {
		// On the body: the root's classes are the reader document's (followTheme).
		this.stripDoc.body.classList.toggle("zf-evo-strip-list", this._collapsed);
	}

	_geometryChanged() {
		if (this._destroyed) return;
		this._emit("geometry");
	}

	/* Where the column stands: for the subclass. */

	// eslint-disable-next-line no-unused-vars
	_showColumn(visible) {}

	/** `live`: while the strip is dragged; the document is fitted at the end. */
	// eslint-disable-next-line no-unused-vars
	_applyWidth(px, live = false) {}

	/**
	 * Keys pressed in the strip outside a text box are handled like keys
	 * pressed on the document: the reader's shortcuts first, and what it does
	 * not use goes on to Obsidian's hotkeys.
	 */
	_onKey(event) {
		const reader = window._reader;
		const keys = reader?._keyboardManager;
		if (!keys || event.defaultPrevented) return;
		if (isTextBox(event.target)) {
			// One exception, as in the reader's comment popup: Delete or
			// Backspace in the untouched, empty comment of an annotation just
			// selected in the document removes that annotation.
			if (event.type !== "keydown" || !["Delete", "Backspace"].includes(event.key)) return;
			if (!reader._enableAnnotationDeletionFromComment) return;
			const ids = reader._state.selectedAnnotationIDs;
			const annotation = ids.length === 1 && reader._state.annotations.find(x => x.id === ids[0]);
			if (!annotation || annotation.comment) return;
		}
		if (event.type === "keydown") keys.handleViewKeyDown(event);
		else keys.handleViewKeyUp(event);
	}

	/* ------------------- places, for the subclass ------------------- */

	/* Only where entries stand beside their place (`canAnchor`). */

	get scrollTop() {
		return 0;
	}

	get clientHeight() {
		return 0;
	}

	/** The top of what is seen of the strip, under its head (anchored only). */
	get viewTop() {
		return 0;
	}

	get contentHeight() {
		return 0;
	}

	anchorOf() {
		return null;
	}

	headingAnchor() {
		return null;
	}

	spotAt() {
		return null;
	}

	reveal() {}

	/**
	 * The annotations as the strip orders them. The same list, unless the
	 * document's kind has something to put right (strip-host-dom.js).
	 */
	withPlaces(annotations) {
		return annotations;
	}

	/**
	 * Where a note that follows an entry of the list is stored.
	 *
	 * @param {{ annotation?: object, heading?: object }} target The entry.
	 * @returns {{ position: object, pageLabel: string, anchor?: number } | null}
	 */
	// eslint-disable-next-line no-unused-vars
	spotAfter(target) {
		return null;
	}

	/**
	 * Where a note for what is being read goes: after the last thing listed
	 * there (`after`), or, with nothing there yet, at a place of its own
	 * (`spot`, with its sort index).
	 *
	 * @param {object[]} annotations
	 * @returns {{ after: object } | { spot: object } | null}
	 */
	// eslint-disable-next-line no-unused-vars
	readingPlace(annotations) {
		return null;
	}

	/** Zotero's sort index for an outline heading, or null if it has no place. */
	// eslint-disable-next-line no-unused-vars
	headingSortIndex(heading) {
		return null;
	}

	/** Called with the outline's headings before their sort indexes are asked for. */
	// eslint-disable-next-line no-unused-vars
	prepareHeadings(headings) {}

	/** Have the view read the document's outline, if it does not by itself. */
	loadOutline() {}

	/** Whether a heading on this page can be placed exactly yet (PDF: the page's text is read). */
	// eslint-disable-next-line no-unused-vars
	hasPageText(pageIndex) {
		return true;
	}

	// eslint-disable-next-line no-unused-vars
	async ensurePageText(pageIndex) {}

	/**
	 * A point in the strip document, as the reader's own document sees it
	 * (for the context menu, which the reader draws in its document).
	 */
	toReaderPoint(clientX, clientY) {
		const frame = this.frame.getBoundingClientRect();
		return { x: clientX + frame.left, y: clientY + frame.top };
	}

	/** Give the keyboard back to the document. */
	focusView() {
		try {
			this.stripDoc.activeElement?.blur?.();
			// The view's frame is already the focused element of the reader's
			// document; what has to move is the focus inside it.
			this.win.focus();
			this.view.focus?.();
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not return the focus to the document:", e);
		}
	}

	destroy() {
		if (this._destroyed) return;
		this._destroyed = true;
		this._listeners.clear();
		this._pointerWaiters = [];
		if (!this.column) return;
		try {
			this.win.removeEventListener("pointerdown", this._onPointerDown, true);
			this.win.removeEventListener("dragstart", this._onDragStart, true);
			for (const type of ["pointerup", "pointercancel", "dragend"]) {
				this.win.removeEventListener(type, this._onPointerEnd, true);
			}
		}
		catch {
			// The view's window is gone already.
		}
		this._headObserver.disconnect();
		if (this._hoverTimer !== null) this.win.clearTimeout(this._hoverTimer);
		unfollowTheme(this.stripDoc);
		unfollowTheme(this.headDoc);
		this.column.remove();
	}
}
