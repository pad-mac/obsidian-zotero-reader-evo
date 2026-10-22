/**
 * ZotFlow Evo: two editors of the PDF editing menu (pdf-edit-panel.js).
 *
 * - Page numbers: a list of ranges, each from the page it starts on, in
 *   numbers (1, 2, 3) or roman numerals (i, ii, iii), from a first number
 *   (1 unless set). "From this page" adds a range at the page being read.
 * - Outline: a table of entries (page, title, level). Pages are typed as
 *   the PDF will show them (the new page numbers, if they are being set);
 *   ‹ › change the level; the arrow goes to the page to try it.
 *
 * Both send pages 0-based; the plugin writes them (evo-pdf-labels.ts).
 */
import React, { useEffect, useMemo, useState } from "react";
import cx from "classnames";

/* ------------------------- page numbers ------------------------- */

export function toRoman(n) {
	if (!Number.isInteger(n) || n <= 0 || n >= 4000) return String(n);
	const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
	let out = "";
	for (const [value, letters] of table) {
		while (n >= value) {
			out += letters;
			n -= value;
		}
	}
	return out;
}

export function fromRoman(text) {
	if (!/^[ivxlcdm]+$/i.test(text)) return null;
	const values = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
	const s = text.toLowerCase();
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const v = values[s[i]];
		const next = values[s[i + 1]] || 0;
		n += v < next ? -v : v;
	}
	return toRoman(n) === s ? n : null;
}

/** The labels of `count` pages from ranges (as evo-pdf-labels.ts does). */
export function labelsFromRanges(ranges, count) {
	const sorted = ranges.filter(r => Number.isInteger(r.start) && r.start >= 0 && r.start < count)
		.sort((a, b) => a.start - b.start);
	const labels = [];
	for (let i = 0; i < count; i++) {
		let range = null;
		for (const r of sorted) if (r.start <= i) range = r;
		if (!range) labels.push(String(i + 1));
		else {
			const n = (range.first || 1) + i - range.start;
			labels.push(range.style === "r" ? toRoman(n) : String(n));
		}
	}
	return labels;
}

/**
 * Ranges that give these labels, where they can be given (numbers and
 * lower-case roman numerals counting up by one); a label of another kind
 * starts a range of numbers counting from its page.
 */
export function detectRanges(labels) {
	const ranges = [];
	let prev = null;
	labels.forEach((label, i) => {
		const text = String(label ?? "").trim();
		let style = null;
		let n = null;
		if (/^\d+$/.test(text)) {
			style = "D";
			n = Number(text);
		}
		else if (fromRoman(text) !== null && text === text.toLowerCase()) {
			style = "r";
			n = fromRoman(text);
		}
		if (!style) {
			style = "D";
			n = i + 1;
		}
		if (!prev || prev.style !== style || prev.n + 1 !== n) {
			ranges.push({ start: i, style, first: n });
		}
		prev = { style, n };
	});
	// Plain numbers from page 1: no labels at all.
	if (ranges.length === 1 && ranges[0].style === "D" && ranges[0].first === 1) return [];
	return ranges;
}

function rangeSummary(ranges, count) {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	if (!sorted.length) return `1–${count}`;
	const parts = [];
	if (sorted[0].start > 0) parts.push(`1–${sorted[0].start}`);
	sorted.forEach((r, i) => {
		const end = (sorted[i + 1]?.start ?? count) - 1;
		const first = r.first || 1;
		const last = first + end - r.start;
		const show = n => (r.style === "r" ? toRoman(n) : String(n));
		parts.push(end > r.start ? `${show(first)}–${show(last)}` : show(first));
	});
	return parts.join(", ");
}

export function LabelEditor({ ranges, count, currentPage, onChange, onGo }) {
	const set = (i, patch) => onChange(ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	const add = () => {
		const start = Math.max(0, Math.min(count - 1, currentPage));
		if (ranges.some(r => r.start === start)) return;
		onChange([...ranges, { start, style: "D", first: 1 }].sort((a, b) => a.start - b.start));
	};
	return (
		<div className="zf-evo-edit-labels">
			{ranges.map((r, i) => (
				<div key={i} className="zf-evo-edit-label-row" data-label-row={i}>
					<span className="zf-evo-edit-muted">from page</span>
					<input
						type="number"
						className="zf-evo-edit-num"
						min={1}
						max={count}
						value={r.start + 1}
						onChange={(event) => {
							const v = Number(event.target.value);
							if (Number.isInteger(v) && v >= 1 && v <= count) set(i, { start: v - 1 });
						}}
						onBlur={() => onChange([...ranges].sort((a, b) => a.start - b.start))}
					/>
					<span className="zf-evo-segmented" role="group" aria-label="Numbering">
						<button type="button" className={cx({ "is-on": r.style === "D" })} aria-pressed={r.style === "D"} onClick={() => set(i, { style: "D" })} title="1, 2, 3">1 2 3</button>
						<button type="button" className={cx({ "is-on": r.style === "r" })} aria-pressed={r.style === "r"} onClick={() => set(i, { style: "r" })} title="i, ii, iii">i ii iii</button>
					</span>
					<span className="zf-evo-edit-muted">starting</span>
					<input
						type="number"
						className="zf-evo-edit-num"
						min={1}
						value={r.first || 1}
						title="The number of the range's first page"
						onChange={(event) => {
							const v = Number(event.target.value);
							if (Number.isInteger(v) && v >= 1) set(i, { first: v });
						}}
					/>
					<button type="button" className="zf-evo-edit-icon" title="Go to this page" onClick={() => onGo(r.start)}>↗</button>
					<button type="button" className="zf-evo-edit-icon" title="Remove this range" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>×</button>
				</div>
			))}
			<div className="zf-evo-edit-row">
				<button type="button" className="zf-evo-edit-link" data-edit="label-add" onClick={add}>
					+ Range from this page ({currentPage + 1})
				</button>
				<span className="zf-evo-edit-muted zf-evo-edit-summary" title="The page numbers the PDF will show">{rangeSummary(ranges, count)}</span>
			</div>
		</div>
	);
}

/* ---------------------------- outline ---------------------------- */

/**
 * The PDF's outline as a flat list ({ title, page, level }), pages 0-based
 * (entries whose destination cannot be found are left out).
 */
export async function readOutline(pdfDocument) {
	const out = [];
	let outline = null;
	try {
		outline = await pdfDocument.getOutline();
	}
	catch {
		return out;
	}
	const pageOf = async (dest) => {
		try {
			const explicit = typeof dest === "string" ? await pdfDocument.getDestination(dest) : dest;
			const ref = Array.isArray(explicit) ? explicit[0] : null;
			if (ref === null || ref === undefined) return null;
			if (Number.isInteger(ref)) return ref;
			return await pdfDocument.getPageIndex(ref);
		}
		catch {
			return null;
		}
	};
	const walk = async (items, level) => {
		for (const item of items || []) {
			const page = await pageOf(item.dest);
			if (page !== null) out.push({ title: item.title || "", page, level });
			await walk(item.items, page !== null ? level + 1 : level);
		}
	};
	await walk(outline, 0);
	return out;
}

/** The page (0-based) a typed page means: a label first, then a plain number. */
export function pageFromInput(text, labels) {
	const t = String(text || "").trim();
	if (!t) return null;
	const byLabel = labels.indexOf(t);
	if (byLabel >= 0) return byLabel;
	const lower = labels.findIndex(l => String(l).toLowerCase() === t.toLowerCase());
	if (lower >= 0) return lower;
	if (/^#?\d+$/.test(t)) {
		const n = Number(t.replace("#", ""));
		if (n >= 1 && n <= labels.length) return n - 1;
	}
	return null;
}

function OutlineRow({ entry, index, labels, maxLevel, onChange, onRemove, onGo }) {
	const [text, setText] = useState(labels[entry.page] ?? String(entry.page + 1));
	// The labels change (the page numbers being set): show the new one.
	useEffect(() => {
		setText(labels[entry.page] ?? String(entry.page + 1));
	}, [labels, entry.page]);
	const page = pageFromInput(text, labels);
	return (
		<div className="zf-evo-edit-outline-row" data-outline-row={index} style={{ "--zf-evo-level": entry.level }}>
			<button type="button" className="zf-evo-edit-icon" title="One level up" disabled={entry.level === 0} onClick={() => onChange({ level: entry.level - 1 })}>‹</button>
			<button type="button" className="zf-evo-edit-icon" title="One level down" disabled={entry.level >= maxLevel} onClick={() => onChange({ level: entry.level + 1 })}>›</button>
			<input
				type="text"
				className={cx("zf-evo-edit-page-input", { "is-invalid": page === null })}
				value={text}
				title="The page as the PDF shows it (or #12 for the 12th page)"
				data-outline-field="page"
				onChange={(event) => {
					setText(event.target.value);
					const p = pageFromInput(event.target.value, labels);
					if (p !== null) onChange({ page: p });
				}}
			/>
			<input
				type="text"
				className="zf-evo-edit-title-input"
				value={entry.title}
				placeholder="Title"
				data-outline-field="title"
				onChange={event => onChange({ title: event.target.value })}
				onKeyDown={(event) => {
					if (event.key !== "Tab") return;
					event.preventDefault();
					if (event.shiftKey) {
						if (entry.level > 0) onChange({ level: entry.level - 1 });
					}
					else if (entry.level < maxLevel) onChange({ level: entry.level + 1 });
				}}
			/>
			<button type="button" className="zf-evo-edit-icon" title="Go to this page" data-outline-go={index} onClick={() => onGo(entry.page)}>↗</button>
			<button type="button" className="zf-evo-edit-icon" title="Remove" onClick={onRemove}>×</button>
		</div>
	);
}

export function OutlineEditor({ entries, labels, currentPage, onChange, onGo }) {
	const sortByPage = list => [...list].sort((a, b) => a.page - b.page);
	const add = () => {
		const page = Math.max(0, Math.min(labels.length - 1, currentPage));
		// After the entries up to this page, at the level of the one before.
		let at = 0;
		while (at < entries.length && entries[at].page <= page) at++;
		const level = at > 0 ? entries[at - 1].level : 0;
		const next = [...entries];
		next.splice(at, 0, { title: "", page, level, fresh: true });
		onChange(next);
	};
	return (
		<div className="zf-evo-edit-outline">
			<div className="zf-evo-edit-outline-list">
				{entries.map((entry, i) => (
					<OutlineRow
						key={i}
						index={i}
						entry={entry}
						labels={labels}
						maxLevel={i === 0 ? 0 : entries[i - 1].level + 1}
						onChange={patch => onChange(entries.map((e, j) => (j === i ? { ...e, ...patch, fresh: false } : e)))}
						onRemove={() => onChange(entries.filter((_, j) => j !== i))}
						onGo={onGo}
					/>
				))}
				{!entries.length && <div className="zf-evo-edit-hint">No outline. Add entries at the pages they go to.</div>}
			</div>
			<div className="zf-evo-edit-row">
				<button type="button" className="zf-evo-edit-link" data-edit="outline-add" onClick={add}>
					+ Entry at this page ({labels[currentPage] ?? currentPage + 1})
				</button>
				<button type="button" className="zf-evo-edit-link" onClick={() => onChange(sortByPage(entries))} title="Order the entries by page">Sort</button>
				{entries.length > 0 && (
					<button type="button" className="zf-evo-edit-link is-danger" onClick={() => onChange([])} title="Remove the whole outline">Clear</button>
				)}
			</div>
		</div>
	);
}

/** The labels the outline editor shows: the new page numbers when they are being set. */
export function useLabels(pageLabels, ranges, count, settingLabels) {
	return useMemo(
		() => (settingLabels ? labelsFromRanges(ranges, count) : (pageLabels?.length === count ? pageLabels.map(String) : Array.from({ length: count }, (_, i) => String(i + 1)))),
		[pageLabels, ranges, count, settingLabels],
	);
}
