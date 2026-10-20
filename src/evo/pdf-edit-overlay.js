/**
 * ZotFlow Evo: what the PDF editing menu draws over the pages (in the PDF
 * view's document) while one of its tools is on:
 *
 * - Split: a vertical line on every page where it will be cut in two. The
 *   red lines share one place: dragging one moves them all. Shift+drag
 *   moves one page's line alone; it turns blue. Shift+double-click on a
 *   blue line makes it red again (back to the shared place).
 * - Extract: chosen pages get a green outline. Shift+click on a page sets
 *   the start of a range, a second Shift+click its end; Ctrl/Cmd+click adds
 *   or removes one page.
 *
 * The layer sits over #viewer and follows the page boxes (zoom, resizing);
 * pdf.js never touches it.
 */

const LAYER_ID = "zf-evo-edit-layer";
const STYLE_ID = "zf-evo-edit-style";
const MIN = 0.05;
const MAX = 0.95;

const CSS = `
#viewer.zf-evo-edit-host { position: relative; }
#${LAYER_ID} { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 5; pointer-events: none; }
#${LAYER_ID} .zf-evo-edit-page { position: absolute; box-sizing: border-box; pointer-events: none; }
#${LAYER_ID} .zf-evo-edit-page.is-picked { outline: 3px solid rgba(46, 160, 67, 0.85); outline-offset: 2px; }
#${LAYER_ID} .zf-evo-split { position: absolute; top: 0; bottom: 0; width: 13px; margin-left: -6px; cursor: ew-resize; pointer-events: auto; }
#${LAYER_ID} .zf-evo-split::after { content: ""; position: absolute; top: 0; bottom: 0; left: 5px; width: 3px; background: rgba(220, 38, 38, 0.85); border-radius: 1px; }
#${LAYER_ID} .zf-evo-split.is-own::after { background: rgba(37, 99, 235, 0.9); }
#${LAYER_ID} .zf-evo-split:hover::after { width: 4px; left: 4.5px; }
`;

const clamp = (x) => Math.min(MAX, Math.max(MIN, x));

export class PdfEditOverlay {
	/**
	 * @param view the reader's PDF view (`reader._primaryView`)
	 * @param onChange called when the split lines or the picked pages change
	 */
	constructor(view, onChange) {
		this.view = view;
		this.win = view._iframeWindow;
		this.doc = this.win.document;
		this.app = this.win.PDFViewerApplication;
		this.viewer = this.doc.getElementById("viewer");
		this.container = this.doc.getElementById("viewerContainer");
		this.onChange = onChange || (() => {});
		this.splitOn = false;
		this.extractOn = false;
		this.shared = 0.5;
		this.own = new Map();
		this.picked = new Set();
		this.anchor = null;

		if (!this.doc.getElementById(STYLE_ID)) {
			const style = this.doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			this.doc.head.appendChild(style);
		}
		this.viewer.classList.add("zf-evo-edit-host");
		this.layer = this.doc.createElement("div");
		this.layer.id = LAYER_ID;
		this.viewer.appendChild(this.layer);

		this._layout = this._layout.bind(this);
		this._onPointerDown = this._onPointerDown.bind(this);
		this._resize = new this.win.ResizeObserver(() => this._layout());
		this._resize.observe(this.viewer);
		this.win.addEventListener("pointerdown", this._onPointerDown, true);
		this._layout();
	}

	get pageCount() {
		return this.app?.pdfViewer?.pagesCount || 0;
	}

	/** The page boxes over the pages, created as needed and placed where the pages are. */
	_layout() {
		const pages = this.app?.pdfViewer?._pages || [];
		const show = this.splitOn || this.extractOn;
		this.layer.style.display = show ? "" : "none";
		if (!show) return;
		while (this.layer.children.length < pages.length) {
			const box = this.doc.createElement("div");
			box.className = "zf-evo-edit-page";
			box.dataset.index = String(this.layer.children.length);
			const line = this.doc.createElement("div");
			line.className = "zf-evo-split";
			line.addEventListener("pointerdown", (event) => this._dragLine(event, Number(box.dataset.index)));
			line.addEventListener("dblclick", (event) => {
				if (!event.shiftKey) return;
				event.preventDefault();
				event.stopPropagation();
				this.own.delete(Number(box.dataset.index));
				this._paint();
				this.onChange();
			});
			box.appendChild(line);
			this.layer.appendChild(box);
		}
		pages.forEach((page, index) => {
			const box = this.layer.children[index];
			const div = page.div;
			box.style.left = div.offsetLeft + div.clientLeft + "px";
			box.style.top = div.offsetTop + div.clientTop + "px";
			box.style.width = div.clientWidth + "px";
			box.style.height = div.clientHeight + "px";
		});
		this._paint();
	}

	_paint() {
		Array.from(this.layer.children).forEach((box, index) => {
			const line = box.firstChild;
			line.style.display = this.splitOn ? "" : "none";
			const own = this.own.get(index);
			line.style.left = ((own ?? this.shared) * 100) + "%";
			line.classList.toggle("is-own", own !== undefined);
			box.classList.toggle("is-picked", this.extractOn && this.picked.has(index));
		});
	}

	_dragLine(event, index) {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const line = event.currentTarget;
		const box = line.parentElement;
		const alone = event.shiftKey || this.own.has(index);
		line.setPointerCapture(event.pointerId);
		const move = (e) => {
			const r = box.getBoundingClientRect();
			const x = clamp((e.clientX - r.left) / r.width);
			if (alone) this.own.set(index, x);
			else this.shared = x;
			this._paint();
		};
		const up = (e) => {
			move(e);
			line.removeEventListener("pointermove", move);
			line.removeEventListener("pointerup", up);
			line.removeEventListener("pointercancel", up);
			this.onChange();
		};
		line.addEventListener("pointermove", move);
		line.addEventListener("pointerup", up);
		line.addEventListener("pointercancel", up);
	}

	/** Shift/Ctrl/Cmd+click on a page while extracting: choose pages. */
	_onPointerDown(event) {
		if (!this.extractOn || event.button !== 0) return;
		const mod = event.ctrlKey || event.metaKey;
		if (!event.shiftKey && !mod) return;
		if (event.target?.closest?.(".zf-evo-split")) return;
		const pageDiv = event.target?.closest?.(".page[data-page-number]");
		if (!pageDiv) return;
		event.preventDefault();
		event.stopPropagation();
		const index = Number(pageDiv.dataset.pageNumber) - 1;
		if (mod) {
			if (!this.picked.delete(index)) this.picked.add(index);
			this.anchor = index;
		}
		else if (this.anchor === null) {
			this.anchor = index;
			this.picked.add(index);
		}
		else {
			const [from, to] = this.anchor <= index ? [this.anchor, index] : [index, this.anchor];
			for (let i = from; i <= to; i++) this.picked.add(i);
			this.anchor = null;
		}
		this._paint();
		this.onChange();
	}

	setSplit(on) {
		this.splitOn = !!on;
		this._layout();
	}

	setExtract(on) {
		this.extractOn = !!on;
		if (!on) this.anchor = null;
		this._layout();
	}

	/** The pages chosen for extraction (from the range field). */
	setPicked(indexes) {
		this.picked = new Set(indexes);
		this.anchor = null;
		this._paint();
	}

	/** Where each page is cut: `{ shared, pages: { index: fraction } }` (fractions of the page's width as shown). */
	getSplit() {
		return { shared: this.shared, pages: Object.fromEntries(this.own) };
	}

	getPicked() {
		return [...this.picked].sort((a, b) => a - b);
	}

	destroy() {
		this._resize.disconnect();
		this.win.removeEventListener("pointerdown", this._onPointerDown, true);
		this.layer.remove();
		this.viewer.classList.remove("zf-evo-edit-host");
	}
}
