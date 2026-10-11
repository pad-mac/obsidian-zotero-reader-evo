import test from "node:test";
import assert from "node:assert/strict";
import { layoutCards, lineAt, estimateHeight, LINE_HEIGHT as L } from "../../src/evo/strip-layout.mjs";

const place = (items) => Object.fromEntries(layoutCards(items));

test("a comment with room keeps its place and full height", () => {
	const out = place([{ id: "a", anchor: 100, natural: 5 * L }, { id: "b", anchor: 400, natural: L }]);
	assert.deepEqual(out.a, { top: 100, height: 5 * L, clamped: false });
	assert.deepEqual(out.b, { top: 400, height: L, clamped: false });
});

test("a tall comment that would reach the next one is cut to two lines", () => {
	const out = place([{ id: "a", anchor: 100, natural: 6 * L }, { id: "b", anchor: 100 + 3 * L, natural: L }]);
	assert.deepEqual(out.a, { top: 100, height: 2 * L, clamped: true });
	assert.deepEqual(out.b, { top: 100 + 3 * L, height: L, clamped: false }, "the next one stays on its own line");
});

test("comments on adjacent lines: the lower one moves down just enough", () => {
	const out = place([
		{ id: "a", anchor: 100, natural: 6 * L },
		{ id: "b", anchor: 100 + L, natural: 4 * L },
		{ id: "c", anchor: 100 + 2 * L, natural: L },
	]);
	assert.deepEqual(out.a, { top: 100, height: 2 * L, clamped: true });
	assert.deepEqual(out.b, { top: 100 + 2 * L, height: 2 * L, clamped: true });
	assert.deepEqual(out.c, { top: 100 + 4 * L, height: L, clamped: false });
});

test("a short comment is never cut; the next one is pushed past it", () => {
	const out = place([{ id: "a", anchor: 100, natural: 2 * L }, { id: "b", anchor: 100 + L, natural: L }]);
	assert.deepEqual(out.a, { top: 100, height: 2 * L, clamped: false });
	assert.equal(out.b.top, 100 + 2 * L);
});

test("the last comment is never cut", () => {
	const out = place([{ id: "a", anchor: 0, natural: 30 * L }]);
	assert.deepEqual(out.a, { top: 0, height: 30 * L, clamped: false });
});

test("no two comments ever share space", () => {
	const items = [];
	let seed = 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	let y = 0;
	for (let i = 0; i < 300; i++) { y += Math.floor(rnd() * 4) * L; items.push({ id: "n" + i, anchor: y, natural: (1 + Math.floor(rnd() * 8)) * L }); }
	const out = layoutCards(items);
	let bottom = -Infinity;
	for (const it of items) {
		const p = out.get(it.id);
		assert.ok(p.top >= bottom, `${it.id} overlaps the one above`);
		assert.ok(p.top >= it.anchor, `${it.id} sits above its own line`);
		assert.ok(p.height >= L, `${it.id} is hidden`);
		bottom = p.top + p.height;
	}
});

test("an unmeasured comment counts as one line", () => {
	assert.equal(place([{ id: "a", anchor: 5, natural: 0 }]).a.height, L);
});

test("lineAt counts lines from the top of the page", () => {
	assert.equal(lineAt(0), 0);
	assert.equal(lineAt(L - 1), 0);
	assert.equal(lineAt(L), 1);
	assert.equal(lineAt(-5), 0);
});

test("estimateHeight grows with the text", () => {
	assert.equal(estimateHeight("", 320), L);
	assert.ok(estimateHeight("x".repeat(400), 320) > estimateHeight("x".repeat(40), 320));
	assert.equal(estimateHeight("a\nb\nc", 320), 3 * L);
});

/* ---------------------------- entries ---------------------------- */

import {
	annotationParts, buildEntries, flattenOutline, lastListed, lastOnPage, pageStartSlot, sortIndexAfter, sortIndexOf,
	usedColors,
} from "../../src/evo/strip-layout.mjs";

const hl = (id, sortIndex, extra = {}) => ({ id, type: "highlight", color: "#ffd400", comment: "", text: "t " + id, sortIndex, ...extra });
const note = (id, sortIndex, extra = {}) => ({ id, type: "note", color: "#ff6666", comment: "n " + id, sortIndex, ...extra });
const ids = entries => entries.map(entry => entry.id);

test("without highlights: notes, and highlights that have a comment or are open", () => {
	const annotations = [
		hl("bare", "00000|000010|00100"),
		hl("commented", "00000|000020|00200", { comment: "c" }),
		note("placed", "00000|000030|00300"),
		{ id: "typed", type: "text", sortIndex: "00000|000001|00010", comment: "on the page" },
		hl("hidden", "00000|000005|00050", { comment: "c", _hidden: true }),
	];
	assert.deepEqual(ids(buildEntries({ annotations })), ["commented", "placed"]);
	assert.deepEqual(ids(buildEntries({ annotations, activeId: "bare" })), ["bare", "commented", "placed"]);
	assert.deepEqual(annotationParts(annotations[0], { activeId: "bare" }), { highlight: false, comment: true });
});

test("with highlights: every highlight, its comment part only when there is one", () => {
	const annotations = [hl("bare", "00000|000010|00100"), hl("commented", "00000|000020|00200", { comment: "c" }), note("placed", "00000|000030|00300")];
	const entries = buildEntries({ annotations, showHighlights: true });
	assert.deepEqual(ids(entries), ["bare", "commented", "placed"]);
	assert.deepEqual(entries.map(entry => entry.parts), [
		{ highlight: true, comment: false },
		{ highlight: true, comment: true },
		{ highlight: false, comment: true },
	]);
});

test("entries follow Zotero's sort index, not the order they arrive in", () => {
	const annotations = [
		note("p2", "00001|000000|00000"),
		hl("p1-late", "00000|000900|00050", { comment: "right column, top" }),
		hl("p1-early", "00000|000100|00600", { comment: "left column, bottom" }),
	];
	assert.deepEqual(ids(buildEntries({ annotations })), ["p1-early", "p1-late", "p2"]);
});

test("the colour filter keeps the chosen colours, any letter case, and the open annotation", () => {
	const annotations = [
		hl("yellow", "00000|000010|00100", { comment: "c", color: "#FFD400" }),
		hl("red", "00000|000020|00200", { comment: "c", color: "#ff6666" }),
		hl("green", "00000|000030|00300", { comment: "c", color: "#5fb236" }),
	];
	assert.deepEqual(ids(buildEntries({ annotations, colors: new Set(["#ffd400"]) })), ["yellow"]);
	assert.deepEqual(ids(buildEntries({ annotations, colors: new Set(["#ffd400", "#5fb236"]) })), ["yellow", "green"]);
	assert.deepEqual(ids(buildEntries({ annotations, colors: new Set(["#ffd400"]), activeId: "red" })), ["yellow", "red"]);
	assert.deepEqual(ids(buildEntries({ annotations, colors: new Set() })), ["yellow", "red", "green"]);
});

test("a draft is listed in its place and stands in for the annotation it became", () => {
	const annotations = [hl("a", "00000|000010|00100", { comment: "c" }), note("made", "00000|000000|00000")];
	const draft = { id: "draft-1", type: "note", comment: "", sortIndex: "00000|000000|00000", createdId: "made" };
	assert.deepEqual(ids(buildEntries({ annotations, draft })), ["draft-1", "a"]);
	// Filters do not hide what is being written.
	assert.deepEqual(ids(buildEntries({ annotations, draft, colors: new Set(["#000000"]) })), ["draft-1"]);
});

test("headings are placed by sort index, ahead of what starts at the same place", () => {
	const annotations = [hl("a", "00001|000000|00000", { comment: "c" }), hl("b", "00002|000050|00100", { comment: "c" })];
	const headings = [
		{ id: "h2", sortIndex: "00002|000000|00000" },
		{ id: "h1", sortIndex: "00001|000000|00000" },
	];
	assert.deepEqual(ids(buildEntries({ annotations, headings })), ["h1", "a", "h2", "b"]);
	// A chapter starting at the top of a page (before any of its text) comes
	// before the notes written for that page, whatever their heights say.
	const pageNote = note("page-note", "00002|000000|00000");
	const topHeading = [{ id: "top", sortIndex: "00002|000000|00032" }];
	assert.deepEqual(ids(buildEntries({ annotations: [pageNote, annotations[1]], headings: topHeading })), ["top", "page-note", "b"]);
	// A colour filter leaves the headings in.
	assert.deepEqual(ids(buildEntries({ annotations, headings, colors: new Set(["#123456"]) })), ["h1", "h2"]);
});

test("the outline is flattened in document order; entries without a place or a title are left out", () => {
	const at = (pageIndex, x, y) => ({ position: { pageIndex, rects: [[x, y, x, y]] } });
	const outline = [
		{ title: "1 Introduction", location: at(0, 72, 700), items: [
			{ title: " 1.1 Aim ", location: at(1, 72, 500), items: [] },
			{ title: "External", url: "https://example.org", items: [] },
		] },
		{ title: "", location: at(2, 0, 0), items: [{ title: "2.1 Nested under nothing", location: at(3, 10, 20) }] },
	];
	const flat = flattenOutline(outline);
	assert.deepEqual(flat.map(h => [h.id, h.title, h.depth, h.pageIndex, h.x, h.y]), [
		["outline-0", "1 Introduction", 0, 0, 72, 700],
		["outline-0-0", "1.1 Aim", 1, 1, 72, 500],
		["outline-1-0", "2.1 Nested under nothing", 1, 3, 10, 20],
	]);
	assert.equal(flat[0].location, outline[0].location, "the place to navigate to is kept");
	assert.deepEqual(flattenOutline(null), []);
});

test("sort index parts are padded and cut as Zotero does", () => {
	assert.equal(sortIndexOf(3, 42, 7.9), "00003|000042|00007");
	assert.equal(sortIndexOf(0, 0, -5), "00000|000000|00000");
	assert.equal(sortIndexOf(123456, 1234567, 123456), "12345|123456|12345");
});

test("a page's notes take the next free slot at the start of the page", () => {
	assert.deepEqual(pageStartSlot(4, []), { slot: 0, sortIndex: "00004|000000|00000" });
	const annotations = [
		note("first", "00004|000000|00000"),
		note("third", "00004|000000|00002"),
		note("other-page", "00005|000000|00007"),
		note("in-the-text", "00004|000120|00300"),
		hl("highlight-at-start", "00004|000000|00009"),
	];
	assert.deepEqual(pageStartSlot(4, annotations), { slot: 3, sortIndex: "00004|000000|00003" });
	// It sorts ahead of everything else on its page and after the page before.
	const entries = buildEntries({ annotations: [...annotations, note("new", "00004|000000|00003"), note("prev", "00003|000999|00700")] });
	assert.deepEqual(ids(entries), ["prev", "first", "third", "new", "in-the-text", "other-page"]);
});

test("used colours come in palette order, unknown ones after", () => {
	const palette = ["#ffd400", "#ff6666", "#5fb236"];
	const annotations = [
		hl("a", "", { color: "#5FB236" }), hl("b", "", { color: "#123456" }), note("c", "", { color: "#ffd400" }),
		hl("d", "", { color: "#ff6666", _hidden: true }), { id: "e", type: "text", color: "#ff6666" },
	];
	assert.deepEqual(usedColors(annotations, palette), ["#ffd400", "#5fb236", "#123456"]);
});

test("on one spot: what was marked, then its notes in the order they were written, the one being written last", () => {
	const at = "00002|000140|00310";
	const annotations = [
		note("second", at, { dateAdded: "2026-10-02T10:00:00Z" }),
		note("first", at, { dateAdded: "2026-10-01T10:00:00Z" }),
		hl("marked", at, { comment: "c", dateAdded: "2026-10-03T10:00:00Z" }),
	];
	assert.deepEqual(ids(buildEntries({ annotations })), ["marked", "first", "second"]);
	const draft = { id: "draft-1", _draft: true, type: "note", comment: "", sortIndex: at, createdId: null };
	assert.deepEqual(ids(buildEntries({ annotations, draft })), ["marked", "first", "second", "draft-1"]);
	// The same in a snapshot, whose sort index is one number.
	const web = [note("n", "0001234", { dateAdded: "2026-10-01T10:00:00Z" }), hl("h", "0001234", { comment: "c", dateAdded: "2026-10-05T10:00:00Z" })];
	assert.deepEqual(ids(buildEntries({ annotations: web })), ["h", "n"]);
});

test("a note written after an entry sorts right behind it, before whatever comes next", () => {
	const annotations = [
		hl("a", "00003|000120|00200", { comment: "c" }),
		hl("b", "00003|000180|00214", { comment: "c" }),
		note("page-note", "00003|000000|00000"),
	];
	const first = sortIndexAfter("00003|000120|00200", annotations);
	assert.equal(first, "00003|000120|00264", "the same place in the text, further on in the last part");
	annotations.push(note("n1", first));
	assert.deepEqual(ids(buildEntries({ annotations })), ["page-note", "a", "n1", "b"]);
	// The next one after that note: behind it.
	const second = sortIndexAfter(first, annotations);
	annotations.push(note("n2", second));
	assert.deepEqual(ids(buildEntries({ annotations })), ["page-note", "a", "n1", "n2", "b"]);
	// One put between the highlight and its first note lands between them.
	const between = sortIndexAfter("00003|000120|00200", annotations);
	assert.equal(between, "00003|000120|00232");
	annotations.push(note("n0", between));
	assert.deepEqual(ids(buildEntries({ annotations })), ["page-note", "a", "n0", "n1", "n2", "b"]);
});

test("without room behind an entry the note takes the entry's own index and the order of writing decides", () => {
	const annotations = [
		hl("a", "00000|000050|00100", { comment: "c", dateAdded: "2026-10-01T10:00:00Z" }),
		note("n1", "00000|000050|00101", { dateAdded: "2026-10-02T10:00:00Z" }),
	];
	const tight = sortIndexAfter("00000|000050|00100", annotations);
	assert.equal(tight, "00000|000050|00100");
	annotations.push(note("n2", tight, { dateAdded: "2026-10-03T10:00:00Z" }));
	assert.deepEqual(ids(buildEntries({ annotations })), ["a", "n2", "n1"]);
	// The last part never grows past its width.
	assert.equal(sortIndexAfter("00000|000050|99990", []), "00000|000050|99999");
	assert.equal(sortIndexAfter("", []), "");
});

test("in a snapshot a note follows by a few characters, halfway to the next annotation at most", () => {
	const annotations = [hl("a", "0001200", { comment: "c" }), hl("b", "0001206", { comment: "c" }), hl("far", "0009000")];
	assert.equal(sortIndexAfter("0001200", annotations), "0001203");
	assert.equal(sortIndexAfter("0001206", annotations), "0001214");
	assert.equal(sortIndexAfter("0009000", annotations), "0009008");
	assert.equal(sortIndexAfter("9999995", []), "9999999");
	// Other documents' formats are left alone: only the same shape counts.
	assert.equal(sortIndexAfter("0001200", [hl("pdf", "00000|000050|01201")]), "0001208");
});

test("the last thing listed on a page, in the strip's order", () => {
	const annotations = [
		hl("early", "00004|000010|00100"),
		hl("late", "00004|000700|00050"),
		note("after-late", "00004|000700|00114"),
		{ id: "typed", type: "text", sortIndex: "00004|000900|00700" },
		hl("gone", "00004|000950|00720", { _hidden: true }),
		hl("next-page", "00005|000001|00001"),
	];
	assert.equal(lastOnPage(4, annotations).id, "after-late");
	assert.equal(lastOnPage(5, annotations).id, "next-page");
	assert.equal(lastOnPage(6, annotations), null);
	assert.equal(lastListed(annotations).id, "next-page");
	assert.equal(lastListed(annotations, annotation => annotation.type === "highlight" && annotation.id !== "next-page").id, "late");
	assert.equal(lastListed([]), null);
});

test("a snapshot's outline: headings placed by a selector are kept", () => {
	const selector = value => ({ position: { type: "CssSelector", value } });
	const outline = [
		{ title: "Title", location: selector("h1"), items: [{ title: "Part one", location: selector("#one"), items: [] }] },
		{ title: "No place", location: {}, items: [] },
	];
	const flat = flattenOutline(outline);
	assert.deepEqual(flat.map(h => [h.id, h.title, h.depth, h.pageIndex]), [
		["outline-0", "Title", 0, undefined],
		["outline-0-0", "Part one", 1, undefined],
	]);
	assert.equal(flat[1].location, outline[0].items[0].location);
	// In a snapshot headings and annotations are ordered by one number.
	const entries = buildEntries({
		annotations: [hl("a", "0000300", { comment: "c" }), hl("b", "0000100", { comment: "c" })],
		headings: [{ id: "h2", sortIndex: "0000200" }, { id: "h1", sortIndex: "0000100" }],
	});
	assert.deepEqual(ids(entries), ["h1", "b", "h2", "a"]);
});
