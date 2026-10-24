/**
 * ZotFlow Evo: a small grey arrow under the page number beside the strip
 * (strip-host-pdf.js, .zf-evo-page-info) that goes back to where the reader
 * was before a jump (the reader's own "back", as the toolbar's button and
 * Alt+← do). Shown only while there is somewhere to go back to, and only
 * with the strip: without it the page number is in the view's header, and
 * the plugin puts the arrow under it there (it is told `back` with the
 * page, reportPageInfo()).
 */

const ARROW_ID = "zf-evo-back";
const STYLE_ID = "zf-evo-back-style";
const STRIP_ON = "zf-evo-strip-on";

const CSS = `
#${ARROW_ID} {
	position: absolute;
	top: 30px;
	right: calc(var(--zf-evo-strip-width, 320px) + 14px);
	z-index: 3;
	display: none;
	align-items: center;
	justify-content: center;
	width: 22px;
	height: 18px;
	border-radius: 4px;
	color: var(--text-faint, rgba(120, 120, 120, 0.8));
	cursor: pointer;
	opacity: 0.85;
	transition: color 90ms ease-out, background-color 90ms ease-out, opacity 140ms ease-out;
}
html.${STRIP_ON} #${ARROW_ID}.is-shown { display: flex; }
#${ARROW_ID}:hover {
	opacity: 1;
	color: var(--text-muted, rgba(90, 90, 90, 0.9));
	background-color: var(--background-modifier-hover, rgba(128, 128, 128, 0.12));
}
#${ARROW_ID} svg { width: 13px; height: 13px; }
html.zf-evo-strip-only #${ARROW_ID} { display: none !important; }
`;

/**
 * Show or hide the arrow in a reader's PDF view (`reader._primaryView`);
 * it is made the first time it is needed.
 */
export function setBackArrow(reader, shown) {
	const view = reader?._primaryView;
	const doc = view?._iframeWindow?.document;
	if (!doc?.body) return;
	let arrow = doc.getElementById(ARROW_ID);
	if (!arrow) {
		if (!shown) return;
		if (!doc.getElementById(STYLE_ID)) {
			const style = doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			doc.head.appendChild(style);
		}
		arrow = doc.createElement("div");
		arrow.id = ARROW_ID;
		arrow.setAttribute("role", "button");
		arrow.setAttribute("aria-label", "Back");
		arrow.title = "Back to where you were before the jump";
		arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
		arrow.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				reader.navigateBack();
			}
			catch (e) {
				console.warn("[ZotFlow Evo] Could not go back:", e);
			}
		});
		(doc.getElementById("mainContainer") || doc.body).appendChild(arrow);
	}
	arrow.classList.toggle("is-shown", !!shown);
}
