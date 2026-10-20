import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateSkew, otsuThreshold, MAX_ANGLE } from "../../src/evo/deskew.mjs";

/** A page of text-like bars, its lines tilted by `degrees` (positive: down to the right). */
function page(degrees, { width = 900, height = 1200, ink = 40, paper = 225, rows = 30 } = {}) {
	const gray = new Uint8Array(width * height).fill(paper);
	const t = Math.tan((degrees * Math.PI) / 180);
	for (let r = 0; r < rows; r++) {
		const y0 = 100 + r * 34;
		for (let x = 90; x < width - 90; x++) {
			if (Math.floor(x / 11) % 6 === 5) continue; // gaps between "words"
			const yc = y0 + (x - width / 2) * t;
			for (let dy = 0; dy < 12; dy++) {
				const y = Math.round(yc + dy);
				if (y >= 0 && y < height) gray[y * width + x] = ink;
			}
		}
	}
	return { gray, width, height };
}

test("otsu splits ink from paper", () => {
	const { gray } = page(0);
	const t = otsuThreshold(gray);
	assert.ok(t >= 40 && t < 225, String(t));
});

for (const degrees of [1.5, -2.3, 0.6, 4.2]) {
	test(`finds a tilt of ${degrees}°`, () => {
		const { gray, width, height } = page(degrees);
		const r = estimateSkew(gray, width, height);
		assert.ok(r.angle !== null, JSON.stringify(r));
		assert.ok(Math.abs(r.angle - degrees) <= 0.06, JSON.stringify(r));
	});
}

test("a level page is left alone", () => {
	const { gray, width, height } = page(0.03);
	assert.equal(estimateSkew(gray, width, height).angle, null);
});

test("an empty page and a picture without lines are left alone", () => {
	const blank = new Uint8Array(800 * 1000).fill(230);
	assert.equal(estimateSkew(blank, 800, 1000).angle, null);
	const noise = new Uint8Array(800 * 1000);
	let s = 7;
	for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; noise[i] = s % 255; }
	assert.equal(estimateSkew(noise, 800, 1000).angle, null);
});

test("beyond the range: left alone, not forced", () => {
	const { gray, width, height } = page(MAX_ANGLE + 3);
	assert.equal(estimateSkew(gray, width, height).angle, null);
});
