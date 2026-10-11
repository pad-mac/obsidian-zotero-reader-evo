/**
 * ZotFlow Evo — the note strip's place in the PDF view.
 *
 * The strip must move exactly with the pages, including while the main
 * thread is busy rendering them. Only the browser can do that, and only for
 * an element in the same document as the scrolling area. But that document
 * belongs to the PDF view, which listens on its window (in the capture
 * phase) for keys, pointer events, drags and copies, and would treat
 * everything in the strip as part of the PDF.
 *
 * So the strip is an iframe:
 *
 *   PDF view document
 *   └─ #mainContainer
 *      ├─ #viewerContainer            the scrolling area, made narrower
 *      └─ #zf-evo-strip-column        beside it, does not scroll
 *         ├─ .zf-evo-banner           pinned title line
 *         └─ .zf-evo-clip
 *            └─ iframe#zf-evo-strip-frame
 *
 * The iframe *element* is as tall as the whole scrolling content and is
 * moved by a scroll-driven animation bound to #viewerContainer, so a point
 * `y` pixels down the strip is always level with the point `y` pixels down
 * the pages. The iframe's *document* keeps the strip's events away from the
 * PDF view. The strip's content is rendered into it by the reader's own
 * React tree (see note-strip.js).
 *
 * In list mode the iframe is simply as tall as the column and scrolls by
 * itself.
 */

import { getSortIndex } from "../pdf/selection";
import { PDF_NOTE_DIMENSIONS } from "../common/defines";
import { followTheme, unfollowTheme } from "../obsidian-evo";
import { LINE_HEIGHT, lineAt } from "./strip-layout.mjs";

const COLUMN_ID = "zf-evo-strip-column";
const FRAME_ID = "zf-evo-strip-frame";
const STYLE_ID = "zf-evo-strip-host-style";
const ON_CLASS = "zf-evo-strip-on";
const ANCHORED_CLASS = "zf-evo-strip-anchored";
const BANNER_HEIGHT = 26;

/** Class on the strip document's root; `_evo.scss` keys the strip's styles off it. */
export const STRIP_DOC_CLASS = "zf-evo-strip-doc";

// Styles for the PDF view's document, which does not load the reader's
// stylesheet. The strip's own look is in `_evo.scss`.
const HOST_CSS = `
#mainContainer { timeline-scope: --zf-evo-scroll; }
#viewerContainer { scroll-timeline: --zf-evo-scroll block; }
html.${ON_CLASS} #viewerContainer { right: var(--zf-evo-strip-width, 320px); }
#${COLUMN_ID} {
	display: none;
	position: absolute;
	top: 0;
	bottom: 0;
	right: 0;
	width: var(--zf-evo-strip-width, 320px);
	box-sizing: border-box;
	background-color: var(--pdf-page-background-color, transparent);
	border-inline-start: 1px solid var(--background-modifier-border, rgba(128, 128, 128, 0.25));
}
html.${ON_CLASS} #${COLUMN_ID} { display: block; }
#${COLUMN_ID} .zf-evo-banner {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	height: ${BANNER_HEIGHT}px;
	box-sizing: border-box;
	padding: 0 10px;
	line-height: ${BANNER_HEIGHT - 1}px;
	font: 12px/${BANNER_HEIGHT - 1}px var(--font-interface, system-ui, sans-serif);
	color: var(--text-muted, #666);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	border-bottom: 1px solid var(--background-modifier-border, rgba(128, 128, 128, 0.25));
	pointer-events: none;
	user-select: none;
}
#${COLUMN_ID} .zf-evo-banner:empty { display: none; }
#${COLUMN_ID} .zf-evo-clip {
	position: absolute;
	top: var(--zf-evo-banner-height, 0px);
	left: 0;
	right: 0;
	bottom: 0;
	/* clip, not hidden: nothing may scroll this box, not even the browser
	   bringing a focused editor into view. The frame is moved by the
	   pages' scroll position alone. */
	overflow: hidden;
	overflow: clip;
}
#${FRAME_ID} {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	border: 0;
	display: block;
	background: transparent;
}
/* Anchored: level with the pages. The frame starts where the scrolling
   content starts, which is above the clip by the banner's height. */
html.${ANCHORED_CLASS} #${FRAME_ID} {
	top: calc(-1 * var(--zf-evo-banner-height, 0px));
	height: var(--zf-evo-content-height, 100%);
	will-change: transform;
}
html.${ANCHORED_CLASS}.zf-evo-strip-timeline #${FRAME_ID} {
	animation: zf-evo-follow linear both;
	animation-timeline: --zf-evo-scroll;
}
@keyframes zf-evo-follow {
	from { transform: translateY(0); }
	to { transform: translateY(calc(-1 * var(--zf-evo-max-scroll, 0px))); }
}
`;

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

/** The strip's place in one PDF view (`reader._primaryView`). */
export class EvoStripHost {
	constructor(view) {
		this.view = view;
		this.win = view._iframeWindow;
		this.doc = this.win.document;
		this.container = this.doc.getElementById("viewerContainer");
		this.viewer = this.doc.getElementById("viewer");
		const main = this.doc.getElementById("mainContainer");
		if (!this.container || !this.viewer || !main) {
			throw new Error("PDF view document is not ready");
		}
		this._listeners = new Set();
		this._collapsed = false;
		this._visible = false;
		this._destroyed = false;
		this.timeline = !!(this.win.CSS?.supports?.("animation-timeline: --x")
			&& this.win.CSS.supports("timeline-scope: --x"));

		if (!this.doc.getElementById(STYLE_ID)) {
			const style = this.doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = HOST_CSS;
			this.doc.head.appendChild(style);
		}

		this.column = this.doc.createElement("div");
		this.column.id = COLUMN_ID;
		this.banner = this.doc.createElement("div");
		this.banner.className = "zf-evo-banner";
		this.clip = this.doc.createElement("div");
		this.clip.className = "zf-evo-clip";
		this.frame = this.doc.createElement("iframe");
		this.frame.id = FRAME_ID;
		this.frame.setAttribute("tabindex", "-1");
		this.frame.setAttribute("title", "Notes");
		this.clip.appendChild(this.frame);
		this.column.append(this.banner, this.clip);
		main.appendChild(this.column);

		// A document of its own, in standards mode.
		const stripDoc = this.frame.contentDocument;
		stripDoc.open();
		stripDoc.write("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
		stripDoc.close();
		this.stripDoc = stripDoc;
		this.stripWin = this.frame.contentWindow;
		copyStyles(document, stripDoc);
		// The strip has the colour of the area around the pages, whatever
		// theme produced it.
		followTheme(stripDoc, STRIP_DOC_CLASS, () => {
			const surface = this.win.getComputedStyle(this.doc.documentElement)
				.getPropertyValue("--pdf-page-background-color").trim();
			if (surface) stripDoc.documentElement.style.setProperty("--zf-evo-surface", surface);
			else stripDoc.documentElement.style.removeProperty("--zf-evo-surface");
		});

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

		this._onWheel = this._onWheel.bind(this);
		this._onKey = this._onKey.bind(this);
		this._onScroll = this._onScroll.bind(this);
		this.stripWin.addEventListener("wheel", this._onWheel, { passive: false });
		this.stripWin.addEventListener("keydown", this._onKey);
		this.stripWin.addEventListener("keyup", this._onKey);
		this.container.addEventListener("scroll", this._onScroll, { passive: true });
		// Whether a mouse button is held on the pages, and whether that press
		// turned into a drag (see afterPointer()). Chrome ends the pointer
		// events when a drag starts, so the end of the drag counts too.
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

		// Where `overflow: clip` is not supported the box can still be scrolled
		// by a focus; put it back.
		this.clip.addEventListener("scroll", () => {
			if (this.clip.scrollTop || this.clip.scrollLeft) this.clip.scrollTo(0, 0);
		});

		// Zoom, page sizes arriving, the pane being resized: all change the
		// size of the scrolling content or of the area it scrolls in.
		this._resizeObserver = new this.win.ResizeObserver(() => this._geometryChanged());
		this._resizeObserver.observe(this.viewer);
		this._resizeObserver.observe(this.container);

		this._applyMode();
	}

	/**
	 * Call `run` once no mouse button is held on the pages: at once, or when
	 * the press ends. It is told whether the press became a drag. Taking the
	 * keyboard focus while an annotation is being pressed or dragged would
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

	/** @param {(event: { type: "geometry" | "scroll" }) => void} listener */
	on(listener) {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	_emit(type) {
		for (const listener of this._listeners) listener({ type });
	}

	get collapsed() {
		return this._collapsed;
	}

	setVisible(visible) {
		visible = !!visible;
		if (visible === this._visible) return;
		this._visible = visible;
		this.doc.documentElement.classList.toggle(ON_CLASS, visible);
		// The scrolling area changed width: let pdf.js refit the pages.
		this.win.dispatchEvent(new this.win.Event("resize"));
		this._geometryChanged();
	}

	setWidth(width) {
		const px = Math.max(160, Math.min(900, Math.round(width) || 320));
		if (px === this._width) return;
		this._width = px;
		this.doc.documentElement.style.setProperty("--zf-evo-strip-width", px + "px");
		if (this._visible) {
			this.win.dispatchEvent(new this.win.Event("resize"));
			this._geometryChanged();
		}
	}

	get width() {
		return this._width || 320;
	}

	setCollapsed(collapsed) {
		collapsed = !!collapsed;
		if (collapsed === this._collapsed) return;
		this._collapsed = collapsed;
		this._applyMode();
		this._emit("geometry");
	}

	setBanner(text) {
		text = String(text || "").trim();
		this.banner.textContent = text;
		this.column.style.setProperty("--zf-evo-banner-height", text ? BANNER_HEIGHT + "px" : "0px");
	}

	_applyMode() {
		const root = this.doc.documentElement;
		root.classList.toggle(ANCHORED_CLASS, !this._collapsed);
		root.classList.toggle("zf-evo-strip-timeline", !this._collapsed && this.timeline);
		// On the body: the root's classes are the reader document's (followTheme).
		this.stripDoc.body.classList.toggle("zf-evo-strip-list", this._collapsed);
		if (this._collapsed) {
			this.frame.style.transform = "";
		}
		this._applyGeometry();
	}

	/** Size the frame to the scrolling content and tell the animation how far it travels. */
	_applyGeometry() {
		if (this._collapsed) return;
		const { scrollHeight, clientHeight } = this.container;
		this.frame.style.setProperty("--zf-evo-content-height", scrollHeight + "px");
		this.frame.style.setProperty("--zf-evo-max-scroll", Math.max(0, scrollHeight - clientHeight) + "px");
		if (!this.timeline) {
			this.frame.style.transform = `translateY(${-this.container.scrollTop}px)`;
		}
	}

	_geometryChanged() {
		if (this._destroyed) return;
		this._applyGeometry();
		this._emit("geometry");
	}

	_onScroll() {
		// Without scroll-driven animations the frame is moved by hand.
		if (!this.timeline && !this._collapsed) {
			this.frame.style.transform = `translateY(${-this.container.scrollTop}px)`;
		}
		this._emit("scroll");
	}

	/** The strip does not scroll by itself: turning the wheel over it scrolls the pages. */
	_onWheel(event) {
		if (this._collapsed || event.ctrlKey || event.metaKey) return;
		const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? this.container.clientHeight : 1;
		this.container.scrollBy({ top: event.deltaY * unit, left: 0, behavior: "instant" });
		event.preventDefault();
	}

	/**
	 * Keys pressed in the strip outside a text box are handled like keys
	 * pressed on the pages: the reader's shortcuts first, and what it does
	 * not use goes on to Obsidian's hotkeys.
	 */
	_onKey(event) {
		const reader = window._reader;
		const keys = reader?._keyboardManager;
		if (!keys || event.defaultPrevented) return;
		if (isTextBox(event.target)) {
			// One exception, as in the reader's comment popup: Delete or
			// Backspace in the untouched, empty comment of an annotation just
			// selected on the page removes that annotation.
			if (event.type !== "keydown" || !["Delete", "Backspace"].includes(event.key)) return;
			if (!reader._enableAnnotationDeletionFromComment) return;
			const ids = reader._state.selectedAnnotationIDs;
			const annotation = ids.length === 1 && reader._state.annotations.find(x => x.id === ids[0]);
			if (!annotation || annotation.comment) return;
		}
		if (event.type === "keydown") keys.handleViewKeyDown(event);
		else keys.handleViewKeyUp(event);
	}

	/* -------------------------- geometry -------------------------- */

	get scrollTop() {
		return this.container.scrollTop;
	}

	get clientHeight() {
		return this.container.clientHeight;
	}

	get contentHeight() {
		return this.container.scrollHeight;
	}

	get pagesCount() {
		return this.win.PDFViewerApplication?.pdfViewer?.pagesCount || 0;
	}

	_pageView(pageIndex) {
		return this.win.PDFViewerApplication?.pdfViewer?._pages?.[pageIndex] || null;
	}

	/** Top and height of a page within the scrolling content, in pixels. */
	pageBox(pageIndex) {
		const pageView = this._pageView(pageIndex);
		if (!pageView?.div) return null;
		const rect = pageView.div.getBoundingClientRect();
		const origin = this.container.getBoundingClientRect();
		return {
			top: rect.top - origin.top + this.container.scrollTop + pageView.div.clientTop,
			height: pageView.div.clientHeight || rect.height,
			viewport: pageView.viewport,
		};
	}

	/**
	 * The strip line an annotation belongs to, as a distance from the top of
	 * the scrolling content. Notes are tied to their middle (they are placed
	 * by it), everything else to its top edge.
	 */
	anchorOf(annotation) {
		const position = annotation.position;
		const rect = position?.rects?.[0];
		const page = position && this.pageBox(position.pageIndex);
		if (!rect || !page?.viewport) return null;
		const [, y1] = page.viewport.convertToViewportPoint(rect[0], rect[1]);
		const [, y2] = page.viewport.convertToViewportPoint(rect[2], rect[3]);
		const offset = annotation.type === "note" ? (y1 + y2) / 2 : Math.min(y1, y2);
		return page.top + lineAt(offset) * LINE_HEIGHT;
	}

	/**
	 * Where a note typed into the strip at `y` goes: on that strip line, at
	 * the right-hand edge of the page. Zotero needs every note to have a
	 * spot on a page; the edge keeps it out of the text.
	 */
	spotAt(y) {
		const count = this.pagesCount;
		let pageIndex = -1;
		let page = null;
		for (let i = 0; i < count; i++) {
			const box = this.pageBox(i);
			if (!box) continue;
			pageIndex = i;
			page = box;
			if (y < box.top + box.height) break;
		}
		if (!page?.viewport) return null;
		const viewport = page.viewport;
		const lines = Math.max(1, Math.floor(page.height / LINE_HEIGHT));
		const line = Math.min(lines - 1, lineAt(y - page.top));
		const half = PDF_NOTE_DIMENSIONS / 2;
		// Worked out on the page as it is shown, so a rotated page is no
		// different: the middle of the line, against the right-hand edge.
		const reach = half * viewport.scale;
		const viewX = viewport.width - reach;
		const viewY = Math.min(
			Math.max(line * LINE_HEIGHT + LINE_HEIGHT / 2, reach),
			Math.max(reach, viewport.height - reach)
		);
		const [x0, y0] = viewport.convertToPdfPoint(viewX, viewY);
		const position = {
			pageIndex,
			rects: [[x0 - half, y0 - half, x0 + half, y0 + half]],
		};
		let sortIndex;
		if (this.view._pdfPages?.[pageIndex]) {
			sortIndex = getSortIndex(this.view._pdfPages, position);
		}
		else {
			// The page's text is not loaded yet: page, then distance from its top.
			const top = Math.max(0, Math.floor((viewY - reach) / viewport.scale));
			sortIndex = [
				String(pageIndex).padStart(5, "0"),
				"000000",
				String(top).padStart(5, "0"),
			].join("|");
		}
		return {
			position,
			sortIndex,
			pageLabel: this.view._getPageLabel?.(pageIndex, true) || String(pageIndex + 1),
			anchor: page.top + line * LINE_HEIGHT,
		};
	}

	/**
	 * A point in the strip document, as the reader's own document sees it
	 * (for the context menu, which the reader draws in its document).
	 */
	toReaderPoint(clientX, clientY) {
		const frame = this.frame.getBoundingClientRect();
		const view = this.view._iframe?.getBoundingClientRect?.() || { left: 0, top: 0 };
		return { x: clientX + frame.left + view.left, y: clientY + frame.top + view.top };
	}

	/**
	 * Scroll the pages just far enough that the part of the strip between
	 * `top` and `bottom` (distances from the top of the scrolling content)
	 * can be seen. The strip cannot scroll by itself, so this is how the
	 * cursor stays in view while writing.
	 */
	reveal(top, bottom, margin = LINE_HEIGHT) {
		if (this._collapsed || this._destroyed) return;
		const banner = this.banner.textContent ? BANNER_HEIGHT : 0;
		const from = this.container.scrollTop + banner + margin;
		const to = this.container.scrollTop + this.container.clientHeight - margin;
		let delta = 0;
		if (bottom > to) delta = Math.min(bottom - to, top - from);
		else if (top < from) delta = top - from;
		if (Math.abs(delta) >= 1) {
			this.container.scrollBy({ top: delta, left: 0, behavior: "instant" });
		}
	}

	/** Give the keyboard back to the pages. */
	focusView() {
		try {
			this.stripDoc.activeElement?.blur?.();
			// The PDF view's frame is already the focused element of the
			// reader's document; what has to move is the focus inside it.
			this.win.focus();
			this.view.focus?.();
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not return the focus to the pages:", e);
		}
	}

	destroy() {
		if (this._destroyed) return;
		this._destroyed = true;
		this._listeners.clear();
		this._resizeObserver.disconnect();
		this.container.removeEventListener("scroll", this._onScroll);
		this.win.removeEventListener("pointerdown", this._onPointerDown, true);
		this.win.removeEventListener("dragstart", this._onDragStart, true);
		for (const type of ["pointerup", "pointercancel", "dragend"]) {
			this.win.removeEventListener(type, this._onPointerEnd, true);
		}
		this._pointerWaiters = [];
		unfollowTheme(this.stripDoc);
		const root = this.doc.documentElement;
		const wasVisible = root.classList.contains(ON_CLASS);
		root.classList.remove(ON_CLASS, ANCHORED_CLASS, "zf-evo-strip-timeline");
		this.column.remove();
		if (wasVisible) {
			try {
				this.win.dispatchEvent(new this.win.Event("resize"));
			}
			catch {
				// The view is going away.
			}
		}
	}
}
