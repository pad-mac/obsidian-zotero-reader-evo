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
 * So the strip's frames (strip-host.js) stand inside the PDF view's document:
 *
 *   PDF view document
 *   └─ #mainContainer
 *      ├─ #viewerContainer            the scrolling area, made narrower
 *      └─ #zf-evo-strip-column        beside it, does not scroll
 *         ├─ iframe#zf-evo-strip-head pinned: title line, filters, buttons
 *         └─ .zf-evo-clip
 *            └─ iframe#zf-evo-strip-frame   the comments
 *
 * Anchored, the strip's iframe *element* is as tall as the whole scrolling
 * content and is moved by a scroll-driven animation bound to
 * #viewerContainer, so a point `y` pixels down the strip is always level
 * with the point `y` pixels down the pages. The iframe's *document* keeps the
 * strip's events away from the PDF view.
 *
 * In list mode the iframe is simply as tall as the clip and scrolls by
 * itself.
 */

import { getSortIndex } from "../pdf/selection";
import { PDF_NOTE_DIMENSIONS } from "../common/defines";
import { StripHost, COLUMN_ID, FRAME_ID, HEAD_ID } from "./strip-host";
import { LINE_HEIGHT, lastOnPage, lineAt, pageStartSlot, sortIndexOf } from "./strip-layout.mjs";

const STYLE_ID = "zf-evo-strip-host-style";
const ON_CLASS = "zf-evo-strip-on";
const ANCHORED_CLASS = "zf-evo-strip-anchored";

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
#${HEAD_ID} {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: var(--zf-evo-head-height, 0px);
	border: 0;
	display: block;
	background: transparent;
}
#${COLUMN_ID} .zf-evo-clip {
	position: absolute;
	top: var(--zf-evo-head-height, 0px);
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
   content starts, which is above the clip by the head's height. */
html.${ANCHORED_CLASS} #${FRAME_ID} {
	top: calc(-1 * var(--zf-evo-head-height, 0px));
	height: var(--zf-evo-content-height, 100%);
	will-change: transform;
}
html.${ANCHORED_CLASS}.zf-evo-strip-timeline #${FRAME_ID} {
	animation: zf-evo-follow linear both;
	animation-timeline: --zf-evo-scroll;
}
/* Anchored, with no comment in view: where the nearest ones are. Shown
   over the strip, not part of it; they take no clicks (this document is
   the PDF view's). */
#${COLUMN_ID} .zf-evo-arrow {
	position: absolute;
	left: 0;
	right: 0;
	z-index: 1;
	display: none;
	justify-content: center;
	align-items: center;
	gap: 3px;
	pointer-events: none;
	color: var(--text-faint, rgba(128, 128, 128, 0.85));
	font-family: var(--font-interface, system-ui, sans-serif);
	font-size: 11px;
	line-height: 14px;
	font-variant-numeric: tabular-nums;
	font-feature-settings: "tnum";
	opacity: 0.8;
}
#${COLUMN_ID} .zf-evo-arrow.is-shown { display: flex; }
#${COLUMN_ID} .zf-evo-arrow.is-up { top: 6px; }
#${COLUMN_ID} .zf-evo-arrow.is-down { bottom: 8px; }
#${COLUMN_ID} .zf-evo-arrow svg { width: 12px; height: 12px; }
/* The strip alone (strip-only): the pages out of sight, the strip across. */
html.zf-evo-strip-only #viewerContainer { visibility: hidden; }
html.zf-evo-strip-only #${COLUMN_ID} { left: 0; width: auto; border-inline-start: 0; }
@keyframes zf-evo-follow {
	from { transform: translateY(0); }
	to { transform: translateY(calc(-1 * var(--zf-evo-max-scroll, 0px))); }
}
`;

/** The strip's place in one PDF view (`reader._primaryView`). */
export class PdfStripHost extends StripHost {
	constructor(view) {
		super(view);
		this.container = this.doc.getElementById("viewerContainer");
		this.viewer = this.doc.getElementById("viewer");
		const main = this.doc.getElementById("mainContainer");
		if (!this.container || !this.viewer || !main) {
			throw new Error("PDF view document is not ready");
		}
		this.timeline = !!(this.win.CSS?.supports?.("animation-timeline: --x")
			&& this.win.CSS.supports("timeline-scope: --x"));

		if (!this.doc.getElementById(STYLE_ID)) {
			const style = this.doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = HOST_CSS;
			this.doc.head.appendChild(style);
		}

		// The strip has the colour of the area around the pages, whatever
		// theme produced it.
		this._build(main, () => this.win.getComputedStyle(this.doc.documentElement)
			.getPropertyValue("--pdf-page-background-color").trim());

		this._onWheel = this._onWheel.bind(this);
		this._onScroll = this._onScroll.bind(this);
		this.stripWin.addEventListener("wheel", this._onWheel, { passive: false });
		this.container.addEventListener("scroll", this._onScroll, { passive: true });

		// Where `overflow: clip` is not supported the box can still be scrolled
		// by a focus; put it back.
		this.clip.addEventListener("scroll", () => {
			if (this.clip.scrollTop || this.clip.scrollLeft) this.clip.scrollTo(0, 0);
		});

		// The arrows towards comments out of view (setArrows()).
		this._arrows = {};
		for (const [dir, path] of [["up", "m18 15-6-6-6 6"], ["down", "m6 9 6 6 6-6"]]) {
			const arrow = this.doc.createElement("div");
			arrow.className = `zf-evo-arrow is-${dir}`;
			arrow.setAttribute("aria-hidden", "true");
			arrow.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg><span></span>`;
			this.clip.appendChild(arrow);
			this._arrows[dir] = arrow;
		}

		// Zoom, page sizes arriving, the pane being resized: all change the
		// size of the scrolling content or of the area it scrolls in.
		this._resizeObserver = new this.win.ResizeObserver(() => this._geometryChanged());
		this._resizeObserver.observe(this.viewer);
		this._resizeObserver.observe(this.container);
	}

	get canAnchor() {
		return true;
	}

	_showColumn(visible) {
		this.doc.documentElement.classList.toggle(ON_CLASS, visible);
		// The scrolling area changed width: let pdf.js refit the pages.
		this.win.dispatchEvent(new this.win.Event("resize"));
	}

	_applyWidth(px, live = false) {
		this.doc.documentElement.style.setProperty("--zf-evo-strip-width", px + "px");
		// While dragged, pdf.js is not asked to fit the pages each time.
		if (this._visible && !live) this.win.dispatchEvent(new this.win.Event("resize"));
	}

	_applyStripOnly(on) {
		this.doc.documentElement.classList.toggle("zf-evo-strip-only", on);
	}

	_applyMode() {
		super._applyMode();
		const root = this.doc.documentElement;
		root.classList.toggle(ANCHORED_CLASS, !this._collapsed);
		root.classList.toggle("zf-evo-strip-timeline", !this._collapsed && this.timeline);
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
		super._geometryChanged();
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

	/* -------------------------- geometry -------------------------- */

	get scrollTop() {
		return this.container.scrollTop;
	}

	/** The top of what is seen of the strip, under its head, in strip pixels. */
	get viewTop() {
		return this.container.scrollTop + (this._headHeight || 0);
	}

	setArrows(up, down) {
		for (const [dir, label] of [["up", up], ["down", down]]) {
			const arrow = this._arrows?.[dir];
			if (!arrow) continue;
			const shown = label !== null && label !== undefined;
			arrow.classList.toggle("is-shown", shown && !this._collapsed);
			const text = shown ? String(label) : "";
			const span = arrow.querySelector("span");
			if (span.textContent !== text) span.textContent = text;
			arrow.title = shown ? `Next comment: page ${text}` : "";
		}
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

	/** The page the PDF view counts as the current one. */
	get currentPageIndex() {
		const number = this.win.PDFViewerApplication?.pdfViewer?.currentPageNumber;
		return number ? number - 1 : 0;
	}

	/**
	 * A spot for a note against the right-hand edge of a page, `viewY` pixels
	 * down the page as it is shown. Zotero needs every note to have a spot on
	 * a page; the edge keeps it out of the text.
	 */
	_edgeSpot(pageIndex, viewY) {
		const page = this.pageBox(pageIndex);
		if (!page?.viewport) return null;
		const viewport = page.viewport;
		const half = PDF_NOTE_DIMENSIONS / 2;
		const reach = half * viewport.scale;
		const viewX = viewport.width - reach;
		const y = Math.min(Math.max(viewY, reach), Math.max(reach, viewport.height - reach));
		const [x0, y0] = viewport.convertToPdfPoint(viewX, y);
		return {
			position: { pageIndex, rects: [[x0 - half, y0 - half, x0 + half, y0 + half]] },
			pageLabel: this.view._getPageLabel?.(pageIndex, true) || String(pageIndex + 1),
			anchor: page.top + lineAt(y) * LINE_HEIGHT,
		};
	}

	/**
	 * Where a note written for a whole page goes on that page: against the
	 * right-hand edge at the top, `slot` places down, so that several of them
	 * do not lie on one spot.
	 */
	pageStartSpot(pageIndex, slot) {
		const viewport = this.pageBox(pageIndex)?.viewport;
		if (!viewport) return null;
		const reach = PDF_NOTE_DIMENSIONS / 2 * viewport.scale;
		return this._edgeSpot(pageIndex, reach + slot * 2 * reach);
	}

	/**
	 * Where a note that follows an entry of the list is stored: against the
	 * right-hand edge of that entry's page, level with it (below it, if the
	 * entry is itself a note there).
	 */
	spotAfter(target) {
		let pageIndex;
		let viewY;
		if (target.heading) {
			pageIndex = target.heading.pageIndex;
			const viewport = this.pageBox(pageIndex)?.viewport;
			if (!viewport) return null;
			viewY = viewport.convertToViewportPoint(target.heading.x, target.heading.y)[1];
		}
		else {
			const position = target.annotation?.position;
			const rect = position?.rects?.[0];
			pageIndex = position?.pageIndex;
			const viewport = rect && this.pageBox(pageIndex)?.viewport;
			if (!viewport) return null;
			const [, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
			const [, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
			const reach = PDF_NOTE_DIMENSIONS / 2 * viewport.scale;
			viewY = target.annotation.type === "note"
				? (y1 + y2) / 2 + 2 * reach
				: Math.min(y1, y2) + reach;
		}
		return this._edgeSpot(pageIndex, viewY);
	}

	/**
	 * A note for the page being read goes after the last thing listed on
	 * that page; on a page with nothing yet, at its start.
	 */
	readingPlace(annotations) {
		const pageIndex = this.currentPageIndex;
		const last = lastOnPage(pageIndex, annotations);
		if (last) return { after: last };
		const { slot, sortIndex } = pageStartSlot(pageIndex, annotations);
		const spot = this.pageStartSpot(pageIndex, slot);
		return spot ? { spot: { ...spot, sortIndex } } : null;
	}

	/** The strip line an outline heading belongs to (see anchorOf()). */
	headingAnchor(heading) {
		const page = this.pageBox(heading.pageIndex);
		if (!page?.viewport) return null;
		const [, y] = page.viewport.convertToViewportPoint(heading.x, heading.y);
		return page.top + lineAt(Math.min(Math.max(y, 0), page.height - 1)) * LINE_HEIGHT;
	}

	/**
	 * Zotero's sort index for an outline heading, so that it can be ordered
	 * among the annotations. Exact once the page's text is known
	 * (ensurePageText()); until then by the heading's height on its page.
	 */
	headingSortIndex(heading) {
		if (!Number.isInteger(heading.pageIndex)) return null;
		const position = {
			pageIndex: heading.pageIndex,
			rects: [[heading.x, heading.y, heading.x, heading.y]],
		};
		if (this.view._pdfPages?.[heading.pageIndex]) {
			return getSortIndex(this.view._pdfPages, position);
		}
		const viewBox = this._pageView(heading.pageIndex)?.viewport?.viewBox;
		const top = viewBox ? viewBox[3] - heading.y : 0;
		return sortIndexOf(heading.pageIndex, 0, top);
	}

	/**
	 * Have the PDF view read the document's outline, as it does when the
	 * outline tab of the reader's sidebar is opened. The result arrives in
	 * the reader's state (`outline`).
	 */
	loadOutline() {
		try {
			Promise.resolve(this.view.setSidebarView?.("outline")).catch((e) => {
				console.warn("[ZotFlow Evo] Could not read the PDF's outline:", e);
			});
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not read the PDF's outline:", e);
		}
	}

	/** Whether the page's text has been read (headingSortIndex() is exact). */
	hasPageText(pageIndex) {
		return !!this.view._pdfPages?.[pageIndex];
	}

	/** Have the PDF view read a page's text. Resolves when it is there. */
	async ensurePageText(pageIndex) {
		await this.view._ensureBasicPageData?.(pageIndex);
	}

	/**
	 * A point in the strip document, as the reader's own document sees it
	 * (for the context menu, which the reader draws in its document).
	 */
	toReaderPoint(clientX, clientY) {
		// The frame is inside the PDF view's frame.
		const inView = super.toReaderPoint(clientX, clientY);
		const view = this.view._iframe?.getBoundingClientRect?.() || { left: 0, top: 0 };
		return { x: inView.x + view.left, y: inView.y + view.top };
	}

	/**
	 * Scroll the pages just far enough that the part of the strip between
	 * `top` and `bottom` (distances from the top of the scrolling content)
	 * can be seen. The strip cannot scroll by itself, so this is how the
	 * cursor stays in view while writing.
	 */
	reveal(top, bottom, margin = LINE_HEIGHT) {
		if (this._collapsed || this._destroyed) return;
		const from = this.container.scrollTop + this._headHeight + margin;
		const to = this.container.scrollTop + this.container.clientHeight - margin;
		let delta = 0;
		if (bottom > to) delta = Math.min(bottom - to, top - from);
		else if (top < from) delta = top - from;
		if (Math.abs(delta) >= 1) {
			this.container.scrollBy({ top: delta, left: 0, behavior: "instant" });
		}
	}

	destroy() {
		if (this._destroyed) return;
		this._resizeObserver.disconnect();
		this.container.removeEventListener("scroll", this._onScroll);
		const root = this.doc.documentElement;
		const wasVisible = root.classList.contains(ON_CLASS);
		root.classList.remove(ON_CLASS, ANCHORED_CLASS, "zf-evo-strip-timeline", "zf-evo-strip-only");
		super.destroy();
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
