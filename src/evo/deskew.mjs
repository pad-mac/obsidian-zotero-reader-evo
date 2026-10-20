/**
 * ZotFlow Evo: how skewed a scanned page is, from a greyscale picture of it.
 *
 * The projection-profile method Leptonica uses (pixFindSkew, also behind
 * Tesseract's and k2pdfopt's/KOReader's straightening): the dark pixels are
 * projected onto lines at a sweep of angles; where the text lines are level
 * the projection has the sharpest peaks and gaps, measured as the sum of the
 * squared differences between neighbouring lines. A coarse sweep, then a
 * fine one around the best.
 *
 * Guard rails: only a rotation is ever found (no stretching), only within
 * ±MAX_ANGLE, and only when the page has enough ink, the best angle is not
 * at the edge of the sweep and clearly beats the rest. Otherwise the page is
 * left alone. No DOM here.
 */

export const MAX_ANGLE = 5;
/** Smaller tilts than this are not worth a rotation. */
export const MIN_ANGLE = 0.1;
const MIN_INK = 1500;
const MAX_POINTS = 150000;
// Leptonica takes a sweep ratio below 3 as unreliable; random texture reaches
// about 3, lines of text far more.
const MIN_CONFIDENCE = 4;

/** Otsu's threshold of 8-bit grey values. */
export function otsuThreshold(gray) {
	const hist = new Float64Array(256);
	for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
	const total = gray.length;
	let sum = 0;
	for (let t = 0; t < 256; t++) sum += t * hist[t];
	let sumB = 0;
	let wB = 0;
	let best = 0;
	let threshold = 128;
	for (let t = 0; t < 256; t++) {
		wB += hist[t];
		if (!wB) continue;
		const wF = total - wB;
		if (!wF) break;
		sumB += t * hist[t];
		const mB = sumB / wB;
		const mF = (sum - sumB) / wF;
		const between = wB * wF * (mB - mF) * (mB - mF);
		if (between > best) {
			best = between;
			threshold = t;
		}
	}
	return threshold;
}

/** Greyscale (0 … 255) of RGBA bytes. */
export function toGray(rgba, width, height) {
	const gray = new Uint8Array(width * height);
	for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
		gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
	}
	return gray;
}

function inkPoints(gray, width, height) {
	const threshold = otsuThreshold(gray);
	let dark = 0;
	for (let i = 0; i < gray.length; i++) if (gray[i] <= threshold) dark++;
	// Light text on a dark page: the ink is the light part.
	const inverted = dark > gray.length / 2;
	const isInk = inverted ? (v) => v > threshold : (v) => v <= threshold;
	const count = inverted ? gray.length - dark : dark;
	const stride = Math.max(1, Math.ceil(count / MAX_POINTS));
	const xs = [];
	const ys = [];
	let seen = 0;
	// A margin of 2% is left out: scanner edges and gutters are not text.
	const mx = Math.round(width * 0.02);
	const my = Math.round(height * 0.02);
	for (let y = my; y < height - my; y++) {
		const row = y * width;
		for (let x = mx; x < width - mx; x++) {
			if (!isInk(gray[row + x])) continue;
			if (seen++ % stride) continue;
			xs.push(x);
			ys.push(y);
		}
	}
	return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

function scoreAt(xs, ys, width, height, degrees) {
	const a = (degrees * Math.PI) / 180;
	const cos = Math.cos(a);
	const sin = Math.sin(a);
	const offset = Math.ceil(width * Math.abs(sin)) + 1;
	const bins = new Float64Array(Math.ceil(height * cos + width * Math.abs(sin)) + 3);
	for (let i = 0; i < xs.length; i++) {
		const v = Math.round(ys[i] * cos - xs[i] * sin) + offset;
		if (v >= 0 && v < bins.length) bins[v]++;
	}
	let score = 0;
	for (let i = 1; i < bins.length; i++) {
		const d = bins[i] - bins[i - 1];
		score += d * d;
	}
	return score;
}

/**
 * The tilt of the text lines in degrees (positive: they go down to the
 * right, as seen), with how sure it is; or null when the page should be
 * left alone (see the guard rails above). `angle` is null as well when the
 * page is level enough.
 */
export function estimateSkew(gray, width, height) {
	const { xs, ys } = inkPoints(gray, width, height);
	if (xs.length < MIN_INK) return { angle: null, confidence: 0, reason: "too little text" };
	const coarse = 0.25;
	let best = 0;
	let bestScore = -1;
	let minScore = Infinity;
	for (let d = -MAX_ANGLE; d <= MAX_ANGLE + 1e-9; d += coarse) {
		const s = scoreAt(xs, ys, width, height, d);
		if (s > bestScore) {
			bestScore = s;
			best = d;
		}
		if (s < minScore) minScore = s;
	}
	if (Math.abs(best) >= MAX_ANGLE - 1e-9) return { angle: null, confidence: 0, reason: "at the edge of the range" };
	const confidence = minScore > 0 ? bestScore / minScore : 0;
	if (confidence < MIN_CONFIDENCE) return { angle: null, confidence, reason: "no clear angle" };
	let fine = best;
	let fineScore = bestScore;
	for (let d = best - coarse; d <= best + coarse + 1e-9; d += 0.02) {
		const s = scoreAt(xs, ys, width, height, d);
		if (s > fineScore) {
			fineScore = s;
			fine = d;
		}
	}
	const angle = Math.round(fine * 100) / 100;
	if (Math.abs(angle) < MIN_ANGLE) return { angle: null, confidence, reason: "level" };
	return { angle, confidence };
}

/**
 * Measure pages of a pdf.js document: each page drawn small, without the
 * theme (`skipBlender`), and its tilt estimated. `{ pageIndex: degrees }`
 * for the pages worth straightening.
 */
export async function measurePages(pdfDocument, pageIndexes, { onProgress, createCanvas } = {}) {
	const angles = {};
	let done = 0;
	for (const index of pageIndexes) {
		const page = await pdfDocument.getPage(index + 1);
		const base = page.getViewport({ scale: 1 });
		const scale = Math.min(3, 1600 / Math.max(base.width, base.height));
		const viewport = page.getViewport({ scale });
		const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.skipBlender = true;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: ctx, viewport, annotationMode: 0 }).promise;
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const { angle } = estimateSkew(toGray(data, canvas.width, canvas.height), canvas.width, canvas.height);
		if (angle !== null) angles[index] = angle;
		page.cleanup();
		onProgress?.(++done, pageIndexes.length);
	}
	return angles;
}
