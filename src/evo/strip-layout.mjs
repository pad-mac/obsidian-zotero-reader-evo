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
