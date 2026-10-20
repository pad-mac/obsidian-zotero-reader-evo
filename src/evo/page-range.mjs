/**
 * ZotFlow Evo: page ranges as typed in the PDF editing menu ("3-7, 12"),
 * by the PDF's own page labels or by page numbers in the file. No DOM here.
 */

/**
 * The page indexes (0-based, ascending, each once) a range text names, or
 * `{ error }` for a part that names no page.
 *
 * @param {string} text
 * @param {{ count: number, labels?: string[], useLabels?: boolean }} options
 */
export function parsePageRange(text, { count, labels = [], useLabels = false }) {
	const indexOf = (token) => {
		const t = token.trim();
		if (!t) return -1;
		if (useLabels) {
			const lower = t.toLowerCase();
			const i = labels.findIndex(label => String(label).toLowerCase() === lower);
			if (i >= 0) return i;
			return -1;
		}
		if (!/^\d+$/.test(t)) return -1;
		const n = Number(t);
		return n >= 1 && n <= count ? n - 1 : -1;
	};
	const out = new Set();
	for (const part of String(text || "").split(/[,;]/)) {
		const p = part.trim();
		if (!p) continue;
		// A range: "3-7", "iv–x". A dash inside a label is rare; a part that
		// is itself a label is taken as one.
		const whole = indexOf(p);
		if (whole >= 0) {
			out.add(whole);
			continue;
		}
		const m = /^(.+?)\s*[-–—]\s*(.*)$/.exec(p);
		if (!m) return { error: p };
		const from = indexOf(m[1]);
		const to = m[2].trim() === "" ? count - 1 : indexOf(m[2]);
		if (from < 0 || to < 0) return { error: p };
		const [a, b] = from <= to ? [from, to] : [to, from];
		for (let i = a; i <= b; i++) out.add(i);
	}
	return [...out].sort((a, b) => a - b);
}

/** Page indexes as a short range text ("3-7, 12"), by labels or by numbers. */
export function formatPageRange(indexes, { labels = [], useLabels = false } = {}) {
	const sorted = [...new Set(indexes)].sort((a, b) => a - b);
	const name = (i) => (useLabels ? String(labels[i] ?? i + 1) : String(i + 1));
	const parts = [];
	for (let i = 0; i < sorted.length; i++) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		parts.push(j > i ? `${name(sorted[i])}-${name(sorted[j])}` : name(sorted[i]));
		i = j;
	}
	return parts.join(", ");
}
