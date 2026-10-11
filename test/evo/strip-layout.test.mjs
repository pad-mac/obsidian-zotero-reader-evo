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
