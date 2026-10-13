/**
 * ZotFlow Evo — the note strip beside a snapshot (a saved web page).
 *
 * A snapshot is one long document that scrolls by itself inside its frame,
 * and the view sizes that frame to the whole of its container. So the strip
 * does not go into the view: its frames (strip-host.js) stand in the
 * reader's own document, at the far side, and the views give up that much
 * width — the way the reader's sidebar does it on the near side:
 *
 *   reader document
 *   ├─ #split-view                 the view(s), made narrower
 *   └─ #zf-evo-strip-column        (styled in `_evo.scss`)
 *
 * Here the strip is a list only. A place in a snapshot is a selector, and
 * its sort index the number of characters before it.
 */

import { caretPositionFromPoint, supportsCaretPositionFromPoint } from "../dom/common/lib/range";
import { closestElement, getContainingBlock } from "../dom/common/lib/nodes";
import { SORT_INDEX_LENGTH } from "../dom/snapshot/defines";
import { StripHost } from "./strip-host";
import { lastListed } from "./strip-layout.mjs";

/** On the reader document's body while the strip is shown. */
const SIDE_CLASS = "zf-evo-side-strip";

/** Where on the screen to look for the paragraph being read, as parts of its height. */
const READING_HEIGHTS = [0.5, 0.35, 0.65, 0.2, 0.8];

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

function formatSortIndex(count) {
	return String(count).padStart(SORT_INDEX_LENGTH, "0").slice(0, SORT_INDEX_LENGTH);
}

/** The strip's place beside a snapshot view (`reader._primaryView`). */
export class DomStripHost extends StripHost {
	constructor(view) {
		super(view);
		if (typeof view.toDisplayedRange !== "function" || typeof view.getAnnotationMeta !== "function") {
			throw new Error("Not a snapshot view");
		}
		this._headingIndex = new Map();
		this._noteIndex = new Map();
		this._build(document.body);
	}

	_showColumn(visible) {
		// The view follows the new width of its container by itself.
		document.body.classList.toggle(SIDE_CLASS, visible);
	}

	_applyWidth(px) {
		document.body.style.setProperty("--zf-evo-strip-width", px + "px");
	}

	get stripOnRight() {
		return getComputedStyle(document.documentElement).direction !== "rtl";
	}

	/** Where an annotation or a heading is on screen, or null if it cannot be found (or is not shown). */
	_rectOf(position) {
		try {
			const rect = this.view.toDisplayedRange(position)?.getBoundingClientRect();
			return rect && (rect.width || rect.height) ? rect : null;
		}
		catch {
			return null;
		}
	}

	/**
	 * The sort index of the place a note is tied to, as the view counts it
	 * for that place. Kept per note, because counting walks the document.
	 */
	_ownSortIndex(annotation) {
		const key = JSON.stringify(annotation.position);
		const known = this._noteIndex.get(annotation.id);
		if (known?.key === key) return known.value;
		let value = null;
		try {
			value = this.view.getAnnotationMeta(annotation.position)?.sortIndex || null;
		}
		catch {
			// Its place cannot be found; it keeps the index it has.
		}
		this._noteIndex.set(annotation.id, { key, value });
		return value;
	}

	/**
	 * A note made with the reader's note tool stands for a whole paragraph,
	 * and its sort index was counted to the start of that paragraph's
	 * *parent* (`SnapshotView.getAnnotationFromRange()`; new notes are put
	 * right there, see the hook). In a list by sort index such a note lands
	 * at the top of its article instead of at its paragraph. Here it is
	 * ordered by where its paragraph begins. What is stored is left alone.
	 */
	withPlaces(annotations) {
		let changed = false;
		const placed = annotations.map((annotation) => {
			if (annotation.type !== "note" || !annotation.position || !annotation.sortIndex) return annotation;
			const own = this._ownSortIndex(annotation);
			// Only an index *before* the note's own text is wrong; one after
			// it is a note written to follow something (sortIndexAfter()).
			if (!own || own.length !== annotation.sortIndex.length || annotation.sortIndex >= own) return annotation;
			changed = true;
			return { ...annotation, sortIndex: own };
		});
		return changed ? placed : annotations;
	}

	/** The place of the paragraph (or other block) an element is in, as a note is given one. */
	_blockPosition(element) {
		const block = element && getContainingBlock(element);
		if (!block || block === this.doc.body || block === this.doc.documentElement) return null;
		const range = this.doc.createRange();
		range.selectNode(block);
		return this.view.getAnnotationFromRange(range, "note")?.position || null;
	}

	/**
	 * A note that follows an entry is tied to the paragraph that entry begins
	 * in, as a note made with the reader's note tool is: its icon then stands
	 * in the margin beside the paragraph, not on the text. Its sort index puts
	 * it right after the entry (sortIndexAfter()).
	 */
	spotAfter(target) {
		const position = target.heading
			? target.heading.location?.position
			: target.annotation?.position;
		if (!position) return null;
		let block = null;
		try {
			const range = this.view.toDisplayedRange(position);
			block = range && this._blockPosition(closestElement(range.startContainer));
		}
		catch {
			// Tied to the entry's own text instead.
		}
		return { position: block || position, pageLabel: "" };
	}

	/** The paragraph (or other block) shown at one of READING_HEIGHTS, as a note's place. */
	_blockSpot() {
		const { innerWidth, innerHeight } = this.win;
		for (const part of READING_HEIGHTS) {
			const x = innerWidth / 2;
			const y = innerHeight * part;
			const caret = supportsCaretPositionFromPoint() && caretPositionFromPoint(this.doc, x, y);
			const element = closestElement(caret ? caret.offsetNode : this.doc.elementFromPoint(x, y));
			const position = this._blockPosition(element);
			if (!position) continue;
			const sortIndex = this.view.getAnnotationMeta(position)?.sortIndex;
			if (!sortIndex) continue;
			return { position, sortIndex, pageLabel: "" };
		}
		return null;
	}

	/**
	 * A note for what is being read goes after the last thing listed that is
	 * on screen; with nothing on screen, on the paragraph in the middle of it.
	 */
	readingPlace(annotations) {
		const height = this.win.innerHeight;
		const last = lastListed(annotations, (annotation) => {
			const rect = this._rectOf(annotation.position);
			return !!rect && rect.bottom > 0 && rect.top < height;
		});
		if (last) return { after: last };
		try {
			const spot = this._blockSpot();
			return spot ? { spot } : null;
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not find a place for the note:", e);
			return null;
		}
	}

	/**
	 * The sort index of every heading, in one walk through the document's
	 * text: the number of characters before the heading, counted the way the
	 * view counts them for an annotation (`SnapshotView._getSortIndex()`).
	 * Asking the view for each heading would walk the text once per heading.
	 */
	prepareHeadings(headings) {
		this._headingIndex = new Map();
		const starts = [];
		for (const heading of headings) {
			let range = null;
			try {
				range = this.view.toDisplayedRange(heading.location?.position);
			}
			catch {
				// That heading is left out.
			}
			if (range) starts.push({ id: heading.id, node: range.startContainer, offset: range.startOffset });
		}
		if (!starts.length) return;
		const following = this.win.Node.DOCUMENT_POSITION_FOLLOWING;
		const walker = this.doc.createNodeIterator(this.doc.body, SHOW_TEXT);
		let count = 0;
		let next = 0;
		for (let node = walker.nextNode(); node && next < starts.length; node = walker.nextNode()) {
			// Several headings can begin at one piece of text.
			while (next < starts.length) {
				const start = starts[next];
				const inside = start.node.contains(node);
				if (!inside && !(start.node.compareDocumentPosition(node) & following)) break;
				const offset = start.node === node ? start.offset : 0;
				this._headingIndex.set(start.id, formatSortIndex(count + offset));
				next++;
			}
			count += node.nodeValue.trim().length;
		}
		// Headings with no text at or after them: at the end.
		for (; next < starts.length; next++) {
			this._headingIndex.set(starts[next].id, formatSortIndex(count));
		}
	}

	headingSortIndex(heading) {
		return this._headingIndex.get(heading.id) ?? null;
	}

	destroy() {
		if (this._destroyed) return;
		document.body.classList.remove(SIDE_CLASS);
		super.destroy();
	}
}
