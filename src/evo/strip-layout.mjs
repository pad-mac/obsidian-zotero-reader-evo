/**
 * ZotFlow Evo — where the comments of the note strip go. Pure functions, no
 * DOM, so the rules can be tested on their own (test/evo/strip-layout.test.mjs).
 */

/** Height of one strip line in CSS pixels. Keep in step with `--zf-evo-line` in `_evo.scss`. */
export const LINE_HEIGHT = 20;

/** Lines a comment keeps when it would run into the next one. */
export const CLAMP_LINES = 2;

/**
 * The strip is ruled into lines counted from the top of each page. A comment
 * sits on the line its annotation falls on; the lines need not match the
 * lines of text on the page.
 *
 * @param {number} offsetInPage Distance from the top of the page, in pixels.
 * @returns {number} Index of the strip line, 0 at the top of the page.
 */
export function lineAt(offsetInPage, lineHeight = LINE_HEIGHT) {
	return Math.max(0, Math.floor(offsetInPage / lineHeight));
}

/**
 * Place the comments.
 *
 * Every comment starts on its own line (`anchor`). Only where a comment would
 * really run into the next one does anything change:
 *  - a comment taller than `clampLines` is cut to that many lines (and drawn
 *    fading out);
 *  - if it still reaches the next comment's line, the next one moves down
 *    just far enough.
 * Nothing is ever hidden entirely, and a comment that has room keeps its
 * full height.
 *
 * @param {{ id: string, anchor: number, natural: number }[]} items Sorted by
 *   `anchor`. `natural` is the comment's full height.
 * @returns {Map<string, { top: number, height: number, clamped: boolean }>}
 */
export function layoutCards(items, { lineHeight = LINE_HEIGHT, clampLines = CLAMP_LINES } = {}) {
	const placed = new Map();
	const limit = clampLines * lineHeight;
	let floor = -Infinity;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const next = items[i + 1];
		const top = Math.max(item.anchor, floor);
		const natural = Math.max(lineHeight, item.natural || lineHeight);
		let height = natural;
		let clamped = false;
		if (next && natural > next.anchor - top && natural > limit) {
			height = limit;
			clamped = true;
		}
		placed.set(item.id, { top, height, clamped });
		floor = top + height;
	}
	return placed;
}

/**
 * Height to assume for a comment that has not been measured yet, so that
 * comments far from the screen need not be rendered to be placed.
 */
export function estimateHeight(text, widthPx, lineHeight = LINE_HEIGHT) {
	const perLine = Math.max(12, Math.floor((widthPx - 64) / 6.6));
	let lines = 0;
	for (const paragraph of String(text || "").split("\n")) {
		lines += Math.max(1, Math.ceil(paragraph.length / perLine));
	}
	return Math.max(1, lines) * lineHeight;
}

/* ------------------------------------------------------------------ *
 * What the strip lists
 * ------------------------------------------------------------------ */

/** Annotation types the strip shows. A "text" annotation is its own text on the page. */
export const LISTED_TYPES = new Set(["highlight", "underline", "note", "image", "ink"]);

/**
 * Which parts of an annotation are shown.
 *  - `highlight`: what was marked on the page (its text, or the image), when
 *    highlights are switched on. A note has none.
 *  - `comment`: the comment. A note is one; anything else has one once it
 *    has text, or while it is open to be written.
 */
export function annotationParts(annotation, { activeId = null, showHighlights = false } = {}) {
	const isNote = annotation.type === "note";
	return {
		highlight: !isNote && !!showHighlights,
		comment: isNote || !!annotation.comment || annotation.id === activeId,
	};
}

function compareEntries(a, b) {
	// Page and place in the page's text first. A heading stands before
	// whatever begins at the same place: a chapter that starts at the top of
	// a page comes before the notes written for that page.
	const placeA = a.sortIndex.slice(0, 12);
	const placeB = b.sortIndex.slice(0, 12);
	if (placeA !== placeB) return placeA < placeB ? -1 : 1;
	if (a.kind !== b.kind) return a.kind === "heading" ? -1 : 1;
	if (a.sortIndex !== b.sortIndex) return a.sortIndex < b.sortIndex ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The strip's entries in reading order: annotations and outline headings,
 * ordered by Zotero's sort index (page, position in the page's text, height).
 *
 * @param {object} options
 * @param {object[]} options.annotations The reader's annotations.
 * @param {{ id: string, sortIndex: string }[]} [options.headings]
 * @param {object | null} [options.draft] A note being written that is not an
 *   annotation yet; `createdId` names the annotation it has become.
 * @param {string | null} [options.activeId] The open annotation. It is listed
 *   whatever the filters say.
 * @param {boolean} [options.showHighlights]
 * @param {Set<string> | null} [options.colors] Lower-case colours to keep;
 *   empty or null keeps all.
 */
export function buildEntries({
	annotations, headings = [], draft = null, activeId = null, showHighlights = false, colors = null,
}) {
	const entries = [];
	for (const annotation of annotations) {
		if (annotation._hidden || !LISTED_TYPES.has(annotation.type)) continue;
		// While a note is being written its entry is the draft's.
		if (draft && draft.createdId === annotation.id) continue;
		const active = annotation.id === activeId;
		if (colors && colors.size && !active && !colors.has(String(annotation.color || "").toLowerCase())) continue;
		const parts = annotationParts(annotation, { activeId, showHighlights });
		if (!parts.highlight && !parts.comment) continue;
		entries.push({ kind: "annotation", id: annotation.id, annotation, parts, sortIndex: annotation.sortIndex || "" });
	}
	if (draft) {
		entries.push({
			kind: "annotation",
			id: draft.id,
			annotation: draft,
			parts: { highlight: false, comment: true },
			sortIndex: draft.sortIndex || "",
		});
	}
	for (const heading of headings) {
		entries.push({ kind: "heading", id: heading.id, heading, sortIndex: heading.sortIndex || "" });
	}
	return entries.sort(compareEntries);
}

/**
 * The PDF's outline as a flat list, in document order.
 *
 * @param {object[] | null} outline The reader's outline: `{ title, items,
 *   location: { position: { pageIndex, rects: [[x, y, x, y]] } } }`.
 * @returns {{ id: string, title: string, depth: number, pageIndex: number, x: number, y: number, location: object }[]}
 */
export function flattenOutline(outline) {
	const out = [];
	const walk = (items, depth, path) => {
		(items || []).forEach((item, index) => {
			const here = path.concat(index);
			const position = item.location?.position;
			const rect = position?.rects?.[0];
			const title = String(item.title || "").trim();
			if (title && rect && Number.isInteger(position.pageIndex)) {
				out.push({
					id: "outline-" + here.join("-"),
					title,
					depth,
					pageIndex: position.pageIndex,
					x: rect[0],
					y: rect[1],
					location: item.location,
				});
			}
			walk(item.items, depth + 1, here);
		});
	};
	walk(outline, 0, []);
	return out;
}

/** The three parts of a Zotero sort index: page, offset in the page's text, distance from the page's top. */
export function sortIndexOf(pageIndex, offset, top) {
	const part = (value, length) => String(Math.max(0, Math.floor(value))).slice(0, length).padStart(length, "0");
	return [part(pageIndex, 5), part(offset, 6), part(top, 5)].join("|");
}

/**
 * Where a note written for a whole page goes: ahead of everything else on
 * the page (offset 0), the notes among themselves in the order they were
 * written. Returns the free slot and its sort index.
 *
 * @param {number} pageIndex
 * @param {{ type: string, sortIndex?: string }[]} annotations
 */
export function pageStartSlot(pageIndex, annotations) {
	const prefix = sortIndexOf(pageIndex, 0, 0).slice(0, 13); // "PPPPP|000000|"
	let slot = 0;
	for (const annotation of annotations) {
		if (annotation.type !== "note" || !String(annotation.sortIndex || "").startsWith(prefix)) continue;
		const taken = Number.parseInt(annotation.sortIndex.slice(13), 10);
		if (Number.isFinite(taken)) slot = Math.max(slot, taken + 1);
	}
	return { slot, sortIndex: sortIndexOf(pageIndex, 0, slot) };
}

/** The colours in use, in the order of `palette` (others after it, as found). */
export function usedColors(annotations, palette) {
	const used = new Set();
	for (const annotation of annotations) {
		if (annotation._hidden || !LISTED_TYPES.has(annotation.type) || !annotation.color) continue;
		used.add(String(annotation.color).toLowerCase());
	}
	const ordered = palette.map(color => color.toLowerCase()).filter(color => used.delete(color));
	return ordered.concat([...used]);
}
