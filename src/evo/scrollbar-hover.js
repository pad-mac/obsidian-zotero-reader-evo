/**
 * ZotFlow Evo: the reader's scrollbar shows only while the pointer is over
 * the strip of the view where it runs (or while it is being dragged), and
 * fades in and out shortly. The thumb's colour carries an animatable
 * property (`--zf-evo-thumb`, 0 … 1) that the hover class sets.
 */

const STYLE_ID = "zf-evo-scrollbar-style";
const SHOWN = "zf-evo-scrollbar-shown";
const SCROLLER = "zf-evo-scroller";

const CSS = `
@property --zf-evo-thumb { syntax: "<number>"; inherits: true; initial-value: 0; }
.${SCROLLER} { --zf-evo-thumb: 0; transition: --zf-evo-thumb 140ms ease-out; }
.${SCROLLER}.${SHOWN} { --zf-evo-thumb: 1; transition-duration: 90ms; }
.${SCROLLER}::-webkit-scrollbar-thumb {
	background-color: rgb(from var(--scrollbar-thumb-bg, rgba(128, 128, 128, 0.35)) r g b / calc(alpha * var(--zf-evo-thumb))) !important;
}
.${SCROLLER}::-webkit-scrollbar-thumb:hover,
.${SCROLLER}::-webkit-scrollbar-thumb:active {
	background-color: rgb(from var(--scrollbar-active-thumb-bg, rgba(128, 128, 128, 0.55)) r g b / calc(alpha * var(--zf-evo-thumb))) !important;
}
`;

/** Width of the band along the right (and bottom) edge that counts as the scrollbar's. */
function zoneOf(el) {
	const bar = Math.max(el.offsetWidth - el.clientWidth, el.offsetHeight - el.clientHeight, 8);
	return bar + 6;
}

/**
 * Make `el` (a scrolling element in its own document) show its scrollbar
 * only on hover of the scrollbar's area. Returns the function that undoes it.
 */
export function hoverScrollbar(el) {
	const doc = el?.ownerDocument;
	const win = doc?.defaultView;
	if (!el || !win || el.classList.contains(SCROLLER)) return () => {};
	if (!doc.getElementById(STYLE_ID)) {
		const style = doc.createElement("style");
		style.id = STYLE_ID;
		style.textContent = CSS;
		doc.head.appendChild(style);
	}
	el.classList.add(SCROLLER);
	let held = false;
	const inZone = (event) => {
		const r = el.getBoundingClientRect();
		const zone = zoneOf(el);
		return event.clientX >= r.right - zone || event.clientY >= r.bottom - zone;
	};
	const show = (on) => el.classList.toggle(SHOWN, on);
	const onMove = (event) => show(held || inZone(event));
	const onLeave = () => {
		if (!held) show(false);
	};
	const onDown = (event) => {
		if (inZone(event)) held = true;
	};
	const onUp = (event) => {
		if (!held) return;
		held = false;
		show(event.target === el || el.contains(event.target) ? inZone(event) : false);
	};
	el.addEventListener("mousemove", onMove, { passive: true });
	el.addEventListener("mouseleave", onLeave);
	el.addEventListener("mousedown", onDown, true);
	win.addEventListener("mouseup", onUp, true);
	return () => {
		el.removeEventListener("mousemove", onMove);
		el.removeEventListener("mouseleave", onLeave);
		el.removeEventListener("mousedown", onDown, true);
		win.removeEventListener("mouseup", onUp, true);
		el.classList.remove(SCROLLER, SHOWN);
	};
}

/** The pages' scrolling element of a PDF view (#viewerContainer). */
export function hoverViewScrollbar(view) {
	const el = view?._iframeWindow?.document?.getElementById("viewerContainer");
	if (el) hoverScrollbar(el);
}
