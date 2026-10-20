import { test } from "node:test";
import assert from "node:assert/strict";
import {
	makePixelFilter, pdfFilterOf, isNeutralPdfFilter, contrastToSlider, sliderToContrast,
	sliderToWhite, whiteToSlider, serializePdfFilter, parsePdfFilter,
} from "../../src/evo/page-filter.mjs";

const px = (filter, r, g = r, b = r) => {
	const data = new Uint8ClampedArray([r, g, b, 255]);
	makePixelFilter(filter).image(data);
	return [data[0], data[1], data[2]];
};

test("neutral filters change nothing", () => {
	assert.equal(makePixelFilter(null), null);
	assert.equal(makePixelFilter({ contrast: 1, whiteThreshold: 255, saturation: 1 }), null);
	assert.ok(isNeutralPdfFilter({}));
});

test("contrast is a gamma (KOReader): darker above 1, white and black stay", () => {
	assert.deepEqual(px({ contrast: 2 }, 128), [64, 64, 64]);
	assert.deepEqual(px({ contrast: 2 }, 255), [255, 255, 255]);
	assert.deepEqual(px({ contrast: 2 }, 0), [0, 0, 0]);
	assert.ok(px({ contrast: 0.8 }, 128)[0] > 128);
});

test("white threshold paints white what is at or above it, after the contrast", () => {
	assert.deepEqual(px({ whiteThreshold: 200 }, 205), [255, 255, 255]);
	assert.deepEqual(px({ whiteThreshold: 200 }, 199), [199, 199, 199]);
	// k2pdfopt's order: contrast first (205 → 132 at gamma 3), then the threshold.
	assert.deepEqual(px({ contrast: 3, whiteThreshold: 200 }, 205), [132, 132, 132]);
	assert.deepEqual(px({ contrast: 3, whiteThreshold: 130 }, 205), [255, 255, 255]);
});

test("saturation 0 is grey", () => {
	const [r, g, b] = px({ saturation: 0 }, 200, 40, 40);
	assert.ok(r === g && g === b, `${r} ${g} ${b}`);
});

test("colours go through the same", () => {
	const [r] = makePixelFilter({ contrast: 2 }).color([0.5, 0.5, 0.5]);
	assert.ok(Math.abs(r - 64 / 255) < 0.01);
});

test("values are kept in range; the earlier fraction is not this threshold", () => {
	assert.deepEqual(pdfFilterOf({ contrast: 99, whiteThreshold: 3, saturation: -1 }), { contrast: 50, whiteThreshold: 16, saturation: 0 });
	assert.equal(pdfFilterOf({ whiteThreshold: 0.2 }).whiteThreshold, 255);
});

test("sliders: contrast logarithmic, snapping to 1; threshold off at the left", () => {
	assert.equal(contrastToSlider(0.8), 0);
	assert.equal(contrastToSlider(50), 1000);
	assert.equal(sliderToContrast(contrastToSlider(1)), 1);
	assert.ok(contrastToSlider(2) < 300, String(contrastToSlider(2)));
	assert.equal(sliderToWhite(0), 255);
	assert.equal(whiteToSlider(200), 55);
	assert.equal(sliderToWhite(55), 200);
});

test("written into and read from a PDF's Info dictionary", () => {
	const text = serializePdfFilter({ contrast: 2, whiteThreshold: 190 });
	assert.deepEqual(JSON.parse(text), { contrast: 2, whiteThreshold: 190, saturation: 1 });
	assert.deepEqual(parsePdfFilter(text), { contrast: 2, whiteThreshold: 190, saturation: 1 });
	assert.equal(parsePdfFilter("nonsense"), null);
});

import { parsePageRange, formatPageRange } from "../../src/evo/page-range.mjs";

test("page ranges: numbers in the file", () => {
	assert.deepEqual(parsePageRange("3-5, 1, 9", { count: 10 }), [0, 2, 3, 4, 8]);
	assert.deepEqual(parsePageRange("8-", { count: 10 }), [7, 8, 9]);
	assert.deepEqual(parsePageRange("5-3", { count: 10 }), [2, 3, 4]);
	assert.deepEqual(parsePageRange("11", { count: 10 }), { error: "11" });
	assert.deepEqual(parsePageRange("", { count: 10 }), []);
});

test("page ranges: the PDF's page labels", () => {
	const labels = ["i", "ii", "iii", "1", "2", "3", "A-1"];
	assert.deepEqual(parsePageRange("ii-1, 3", { count: 7, labels, useLabels: true }), [1, 2, 3, 5]);
	assert.deepEqual(parsePageRange("A-1", { count: 7, labels, useLabels: true }), [6]);
	assert.deepEqual(parsePageRange("iv", { count: 7, labels, useLabels: true }), { error: "iv" });
	assert.equal(formatPageRange([1, 2, 3, 5], { labels, useLabels: true }), "ii-1, 3");
	assert.equal(formatPageRange([0, 1, 2, 7]), "1-3, 8");
});
