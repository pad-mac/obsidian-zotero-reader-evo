/**
 * ZotFlow Evo: the page filter for PDFs, as KOReader does it (k2pdfopt's
 * order: contrast first, then the white threshold on the result).
 *
 * - contrast: a gamma, as KOReader's "Contrast" (0.8 … 50, 1 = as it is).
 *   Above 1 every tone gets darker, white and black stay.
 * - whiteThreshold: as KOReader's "White Threshold" (255 = off). Every
 *   pixel whose grey value is at or above it is painted white; the rest
 *   stays as the contrast left it.
 * - saturation: as KOReader's (1 = as it is, 0 = grey).
 *
 * The values are kept per PDF in these units, so other readers (the
 * KOReader plugin) can use them as they are. No DOM here.
 */

export const NEUTRAL_PDF_FILTER = Object.freeze({ contrast: 1, whiteThreshold: 255, saturation: 1 });

export const CONTRAST_MIN = 0.8;
export const CONTRAST_MAX = 50;
export const WHITE_MIN = 16;
export const SATURATION_MAX = 2;

/** The key in a PDF's Info dictionary that holds the filter (JSON). */
export const PDF_INFO_KEY = "ZotFlowEvoPageFilter";

const clamp = (n, lo, hi, fallback) => (typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback);

/** The filter's values within range (missing or unreadable ones neutral). */
export function pdfFilterOf(value) {
	let white = value?.whiteThreshold;
	// Until beta.9 the threshold was a fraction (0 … 0.5) of a different
	// curve: not this one.
	if (typeof white === "number" && white < 1) white = 255;
	return {
		contrast: Math.round(clamp(value?.contrast, CONTRAST_MIN, CONTRAST_MAX, 1) * 100) / 100,
		whiteThreshold: Math.round(clamp(white, WHITE_MIN, 255, 255)),
		saturation: Math.round(clamp(value?.saturation, 0, SATURATION_MAX, 1) * 100) / 100,
	};
}

export function isNeutralPdfFilter(filter) {
	const f = pdfFilterOf(filter);
	return f.contrast === 1 && f.whiteThreshold === 255 && f.saturation === 1;
}

/* Slider positions (0 … 1000) and values. Contrast is logarithmic, so the
   range below 2 gets as much room as the one above. */
export function contrastToSlider(contrast) {
	const c = clamp(contrast, CONTRAST_MIN, CONTRAST_MAX, 1);
	return Math.round(1000 * Math.log(c / CONTRAST_MIN) / Math.log(CONTRAST_MAX / CONTRAST_MIN));
}
export function sliderToContrast(position) {
	const t = clamp(position, 0, 1000, 0) / 1000;
	const c = CONTRAST_MIN * Math.pow(CONTRAST_MAX / CONTRAST_MIN, t);
	// Snap to 1 near it, so the neutral value can be found again.
	if (Math.abs(c - 1) < 0.03) return 1;
	return Math.round(c * (c < 10 ? 100 : 10)) / (c < 10 ? 100 : 10);
}
/* White threshold: the slider goes from off (255) on the left to more
   white on the right. */
export function whiteToSlider(white) {
	return 255 - clamp(white, WHITE_MIN, 255, 255);
}
export function sliderToWhite(position) {
	return 255 - Math.round(clamp(position, 0, 255 - WHITE_MIN, 0));
}

/**
 * The filter as functions over pixels and colours, or null when it changes
 * nothing. `image(data)` works in place on RGBA bytes; `color(rgb)` takes and
 * gives 0 … 1 components.
 */
export function makePixelFilter(value) {
	if (isNeutralPdfFilter(value)) return null;
	const { contrast, whiteThreshold, saturation } = pdfFilterOf(value);
	const gamma = new Uint8ClampedArray(256);
	for (let v = 0; v < 256; v++) gamma[v] = Math.round(255 * Math.pow(v / 255, contrast));
	const white = whiteThreshold;
	const sat = saturation;
	const one = (r, g, b) => {
		if (sat !== 1) {
			const y = 0.299 * r + 0.587 * g + 0.114 * b;
			r = Math.max(0, Math.min(255, Math.round(y + (r - y) * sat)));
			g = Math.max(0, Math.min(255, Math.round(y + (g - y) * sat)));
			b = Math.max(0, Math.min(255, Math.round(y + (b - y) * sat)));
		}
		r = gamma[r];
		g = gamma[g];
		b = gamma[b];
		if (white < 255 && (299 * r + 587 * g + 114 * b) / 1000 >= white) {
			r = g = b = 255;
		}
		return [r, g, b];
	};
	return {
		image(data) {
			for (let i = 0; i < data.length; i += 4) {
				let r = data[i];
				let g = data[i + 1];
				let b = data[i + 2];
				if (sat !== 1) {
					const y = 0.299 * r + 0.587 * g + 0.114 * b;
					r = y + (r - y) * sat;
					g = y + (g - y) * sat;
					b = y + (b - y) * sat;
					r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
					g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
					b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
				}
				r = gamma[r];
				g = gamma[g];
				b = gamma[b];
				if (white < 255 && 299 * r + 587 * g + 114 * b >= white * 1000) {
					r = g = b = 255;
				}
				data[i] = r;
				data[i + 1] = g;
				data[i + 2] = b;
			}
		},
		color(rgb) {
			const [r, g, b] = one(Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255));
			return [r / 255, g / 255, b / 255];
		},
	};
}

/** The filter as written into a PDF's Info dictionary (KOReader units). */
export function serializePdfFilter(value) {
	return JSON.stringify(pdfFilterOf(value));
}

/** The filter from a PDF's Info dictionary, or null. */
export function parsePdfFilter(text) {
	if (typeof text !== "string" || !text.trim().startsWith("{")) return null;
	try {
		return pdfFilterOf(JSON.parse(text));
	}
	catch {
		return null;
	}
}
