/**
 * ZotFlow Evo — fork-only reader behaviour.
 *
 * Everything the fork adds to the reader lives in this file and in
 * `common/stylesheets/components/_evo.scss`; the upstream files only call
 * into it. That keeps merges from upstream small. The list of hooks is in
 * FORK.md in the plugin repository (pad-mac/zotflow-evo).
 */

import {
	NEUTRAL_PDF_FILTER, PDF_INFO_KEY, isNeutralPdfFilter, makePixelFilter, parsePdfFilter, pdfFilterOf, serializePdfFilter,
} from "./evo/page-filter.mjs";
import { ObsidianBridge } from "./obsidian-adapter";

const RESOLVED_STYLE_ID = "zf-evo-resolved-vars";

/** On the reader document's body (and the strip's) when the strip is all that is shown. */
export const STRIP_ONLY_CLASS = "zf-evo-strip-only";
const TOOLBAR_HIDDEN_CLASS = "zf-evo-toolbar-hidden";

/**
 * Reader state key holding the note strip's settings (`evo/note-strip.js`).
 * `common/components/reader-ui.js` reads it too: while the strip is shown the
 * comment popup is not opened.
 */
export const NOTE_STRIP_STATE = "zfEvoStrip";

/** Whether a document of this kind (`reader._type`) can have the note strip. */
export function hasNoteStrip(type) {
	return type === "pdf" || type === "snapshot";
}

/**
 * Variables the reader's Obsidian theme reads (`themes/_obsidian.scss`,
 * `components/_evo.scss`, the scrollbar rules). They are resolved even when
 * the stylesheet scan below finds no declaration for them.
 */
const CORE_VARIABLES = [
	"--background-primary",
	"--background-primary-alt",
	"--background-secondary",
	"--background-secondary-alt",
	"--background-modifier-border",
	"--background-modifier-form-field",
	"--background-modifier-hover",
	"--text-normal",
	"--text-muted",
	"--text-faint",
	"--text-accent",
	"--text-on-accent",
	"--interactive-accent",
	"--color-accent",
	"--color-red",
	"--color-orange",
	"--color-yellow",
	"--color-green",
	"--color-cyan",
	"--color-blue",
	"--color-purple",
	"--color-pink",
	"--scrollbar-bg",
	"--scrollbar-thumb-bg",
	"--scrollbar-active-thumb-bg",
];

/**
 * Never copied. Same list as the filter in `adoptObsidianStyles()`
 * (index.obsidian.reader.js): Obsidian bundles its own pdf.js styles, and
 * these names mean something else inside the reader's viewer.
 */
const EXCLUDED_VARIABLES = new Set(["--page-border"]);

/* ------------------------------------------------------------------ *
 * Theme: Obsidian's variables as the app actually computes them
 * ------------------------------------------------------------------ */

/**
 * Upstream copies Obsidian's variables by reading stylesheet rules whose
 * selector is exactly `body`, `:root`, `.theme-light` or `.theme-dark`. A
 * theme, a snippet or Style Settings that sets a colour under any other
 * selector (`body.theme-light`, `.theme-light.my-scheme`, an inline style on
 * `body`, …) is missed, and the reader then shows the default light or dark
 * palette instead of the theme's.
 *
 * Here the values are read where they are final: the computed style of the
 * element that hosts the reader. Whatever produced them, these are the
 * colours Obsidian shows around the reader.
 */

/** The reader iframe's element in Obsidian, with its window and document. */
function getHost() {
	try {
		const frame = window.frameElement;
		const doc = frame?.ownerDocument;
		if (frame && doc?.defaultView && doc.body) {
			return { el: frame, win: doc.defaultView, doc };
		}
	}
	catch {
		// Not same-origin: fall through.
	}
	try {
		const parent = window.parent;
		if (parent && parent !== window && parent.document?.body) {
			return { el: parent.document.body, win: parent, doc: parent.document };
		}
	}
	catch {
		// No reachable host.
	}
	return null;
}

function addCustomPropertyNames(style, names) {
	if (!style) return;
	for (let i = 0; i < style.length; i++) {
		const name = style[i];
		if (name.startsWith("--")) names.add(name);
	}
}

/** Every custom property declared in `rules`, at any nesting depth. */
function collectFromRules(rules, names) {
	for (const rule of Array.from(rules || [])) {
		addCustomPropertyNames(rule.style, names);
		// @import
		if (rule.styleSheet) collectFromSheet(rule.styleSheet, names);
		// @media, @supports, @layer, @container, nested style rules
		if (rule.cssRules?.length) collectFromRules(rule.cssRules, names);
	}
}

function readRules(sheet) {
	try {
		return sheet.cssRules;
	}
	catch {
		// A stylesheet from another origin cannot be read.
		return null;
	}
}

function collectFromSheet(sheet, names) {
	collectFromRules(readRules(sheet), names);
}

/**
 * True for a stylesheet that only carries Obsidian's variables into a reader
 * document: ours, or the one `adoptObsidianStyles()` prepends to a view
 * iframe (recognisable by the `:root > .obsidian-app` selector it uses).
 */
function isCopiedVariableSheet(sheet) {
	if (sheet.ownerNode?.id === RESOLVED_STYLE_ID) return true;
	if (sheet.href) return false;
	for (const rule of Array.from(readRules(sheet) || [])) {
		if (rule.selectorText?.includes(":root > .obsidian-app")) return true;
	}
	return false;
}

/** Custom properties declared by every stylesheet `doc` links or embeds. */
function collectFromDocument(doc, names, { skipCopied = false } = {}) {
	if (!doc) return;
	for (const sheet of Array.from(doc.styleSheets || [])) {
		if (skipCopied && isCopiedVariableSheet(sheet)) continue;
		collectFromSheet(sheet, names);
	}
}

const ownNamesByDocument = new WeakMap();

/**
 * Custom properties a reader document declares itself. They are never
 * overridden: `--color-toolbar` belongs to the reader's themes, and the
 * viewer's own variables belong to pdf.js.
 */
function getOwnNames(doc) {
	let names = ownNamesByDocument.get(doc);
	if (!names) {
		names = new Set();
		collectFromDocument(doc, names, { skipCopied: true });
		// Only cache a real result; a stylesheet may still be loading.
		if (names.size) ownNamesByDocument.set(doc, names);
	}
	return names;
}

function getHostScheme(host) {
	const classes = host.doc.body.classList;
	if (classes.contains("theme-dark")) return "dark";
	if (classes.contains("theme-light")) return "light";
	return host.win.getComputedStyle(host.doc.body).colorScheme === "dark"
		? "dark"
		: "light";
}

/**
 * @returns {{ scheme: "light" | "dark", values: Map<string, string> } | null}
 */
function resolveObsidianVariables() {
	const host = getHost();
	if (!host) return null;

	const names = new Set(CORE_VARIABLES);
	collectFromDocument(host.doc, names);
	// In a pop-out window the stylesheets may live in the main window.
	try {
		const main = window.findParentWindow?.();
		if (main?.document && main.document !== host.doc) {
			collectFromDocument(main.document, names);
		}
	}
	catch {
		// Unreachable opener: the host document is enough.
	}
	// Inline styles: Obsidian sets the accent colour on `body` this way.
	for (let el = host.el; el; el = el.parentElement) {
		addCustomPropertyNames(el.style, names);
	}

	const computed = host.win.getComputedStyle(host.el);
	const values = new Map();
	for (const name of names) {
		if (EXCLUDED_VARIABLES.has(name)) continue;
		const value = computed.getPropertyValue(name).trim();
		if (value) values.set(name, value);
	}
	return { scheme: getHostScheme(host), values };
}

let lastResolved = null;

/**
 * Write the resolved variables into `doc` (the reader document or one of
 * its view iframes).
 *
 * The rule is tied to the scheme Obsidian had when the values were read, so
 * it is inert when the reader is forced to the opposite scheme; upstream's
 * extraction then applies as before. Its selector outranks upstream's
 * `html.obsidian-theme-*` rules and the scoped copy of app.css.
 */
export function applyResolvedObsidianVariables(doc, resolved = lastResolved) {
	if (!doc || !resolved) return;
	try {
		const own = getOwnNames(doc);
		let style = doc.getElementById(RESOLVED_STYLE_ID);
		if (!style) {
			style = doc.createElement("style");
			style.id = RESOLVED_STYLE_ID;
			(doc.head || doc.documentElement).appendChild(style);
		}
		const sheet = style.sheet;
		if (!sheet) return;
		while (sheet.cssRules.length) sheet.deleteRule(0);
		const scheme = `html.obsidian-theme-${resolved.scheme}:root`;
		sheet.insertRule(`${scheme}, ${scheme} .obsidian-app {}`, 0);
		// Set through the CSSOM: no value can break out of the rule.
		const declarations = sheet.cssRules[0].style;
		for (const [name, value] of resolved.values) {
			if (!own.has(name)) declarations.setProperty(name, value);
		}
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not apply Obsidian variables:", e);
	}
}

/**
 * Read Obsidian's variables again and write them into every given document.
 * Called when the reader opens and whenever Obsidian's CSS changes.
 */
export function refreshResolvedObsidianVariables(docs) {
	try {
		lastResolved = resolveObsidianVariables();
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not read Obsidian variables:", e);
		return;
	}
	if (!lastResolved) return;
	console.log(
		`[ZotFlow Evo] Resolved ${lastResolved.values.size} Obsidian variables`
		+ ` (${lastResolved.scheme});`
		+ ` --background-primary = ${lastResolved.values.get("--background-primary") ?? "(unset)"}`
	);
	for (const doc of docs) {
		applyResolvedObsidianVariables(doc, lastResolved);
	}
}

/**
 * Documents the fork creates itself (the note strip) take their theme from
 * the reader document: the classes and data attributes on its root, which
 * the reader's stylesheet keys off, and the resolved variables.
 */
const themeFollowers = new Map();

function syncThemeFollower(doc, { ownClass, after }) {
	const from = document.documentElement;
	const to = doc.documentElement;
	if (!to) return;
	to.className = `${from.className} ${ownClass}`.trim();
	// The build writes direction-dependent rules as `html[dir="ltr"] …`.
	to.setAttribute("dir", from.getAttribute("dir") || "ltr");
	if (from.lang) to.lang = from.lang;
	for (const name of Array.from(to.attributes, attr => attr.name)) {
		if (name.startsWith("data-") && !from.hasAttribute(name)) to.removeAttribute(name);
	}
	for (const attr of Array.from(from.attributes)) {
		if (attr.name.startsWith("data-")) to.setAttribute(attr.name, attr.value);
	}
	applyResolvedObsidianVariables(doc);
	after?.();
}

/**
 * Keep `doc` themed like the reader document. `ownClass` stays on its root;
 * `after` runs each time the theme has been applied.
 */
export function followTheme(doc, ownClass = "", after = null) {
	const follower = { ownClass, after };
	themeFollowers.set(doc, follower);
	syncThemeFollower(doc, follower);
}

export function unfollowTheme(doc) {
	themeFollowers.delete(doc);
}

/** Call after the reader document's theme classes or variables changed. */
export function syncThemeFollowers() {
	for (const [doc, follower] of themeFollowers) {
		try {
			syncThemeFollower(doc, follower);
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not theme a document:", e);
		}
	}
}

/* ------------------------------------------------------------------ *
 * Reader chrome toggled from the Obsidian view header
 * ------------------------------------------------------------------ */

/** Show or hide the reader's toolbar. Layout follows in `_evo.scss`. */
export function applyToolbarHidden(hidden) {
	document.body?.classList.toggle(TOOLBAR_HIDDEN_CLASS, !!hidden);
}

/**
 * Settings of the note strip beside a PDF or a snapshot: `{ visible,
 * collapsed, width, banner, highlights }`. Merged into what is already set,
 * so one field can change alone.
 */
export function applyNoteStrip(reader, settings) {
	if (!reader?._updateState) return;
	const current = reader._state?.[NOTE_STRIP_STATE] || {};
	const next = { ...current, ...settings };
	reader._updateState({ [NOTE_STRIP_STATE]: next });
	// The strip alone, in a tab of its own (the plugin's "annotation strip"):
	// the document stays loaded but out of sight (`_evo.scss`).
	document.body?.classList.toggle(STRIP_ONLY_CLASS, !!next.stripOnly);
	if ("pdfFilter" in settings) applyPdfFilter(reader);
	// The plugin sends the header's buttons when it has started listening to
	// this reader: the page it may have missed.
	if ("actions" in settings && lastPageInfo) reportPageInfo(lastPageInfo);
	const visible = !!next.visible && reader._type === "pdf";
	if (visible !== stripShowsNotes) {
		stripShowsNotes = visible;
		// Notes on the page edge appear or disappear (see below).
		try {
			reader._primaryView?._render?.();
			reader._secondaryView?._render?.();
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not redraw the pages:", e);
		}
	}
}

/**
 * A strip setting changed in the strip itself (the "highlights" button):
 * apply it here and tell the plugin, which keeps it and passes it on to the
 * other open readers.
 */
export function reportNoteStrip(reader, settings) {
	applyNoteStrip(reader, settings);
	try {
		ObsidianBridge?.handleEvent?.({ type: "noteStripChanged", settings });
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not report a note strip setting:", e);
	}
}

/** The page last reported (sent again when the plugin starts listening). */
let lastPageInfo = null;

/** The page being read (`{ label, index, count }`), for the plugin's view header. */
export function reportPageInfo(info) {
	lastPageInfo = info;
	try {
		ObsidianBridge?.handleEvent?.({ type: "pageInfo", ...info });
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not report the page:", e);
	}
}

/**
 * The strip alone: the PDF view's pages hidden at once, before the strip
 * (which hides them for good, strip-host-pdf.js) has started.
 */
export function hidePagesEarly(view) {
	const doc = view?._iframeWindow?.document;
	if (!doc?.head || doc.getElementById("zf-evo-early-hide")) return;
	const style = doc.createElement("style");
	style.id = "zf-evo-early-hide";
	style.textContent = "#viewerContainer, #sidebarContainer { visibility: hidden !important; }";
	doc.head.appendChild(style);
}

/**
 * The strip alone (strip-only): an entry or heading is to be opened in a
 * reader of its own, at `location` (`{ annotationID }`, or a heading's place).
 */
export function reportNoteStripOpen(location) {
	try {
		ObsidianBridge?.handleEvent?.({ type: "noteStripOpen", location });
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not ask to open the place:", e);
	}
}

/**
 * A button of the Obsidian view, shown in the strip's head while the view's
 * own header is hidden, was clicked: the plugin clicks the real one. `x`,
 * `y`: where, in the reader's document (for a menu the button opens).
 */
export function reportNoteStripAction(id, x, y) {
	try {
		ObsidianBridge?.handleEvent?.({ type: "noteStripAction", id, x, y });
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not pass on a note strip button:", e);
	}
}

let stripShowsNotes = false;

/**
 * A note written in the strip is stored against the right-hand edge of its
 * page (Zotero needs every note to have a spot on a page). While the strip
 * is open that note is shown in the strip and its icon is left off the
 * page. Called from `_pushNote()` in `pdf/page.js` with the note's rectangle
 * and the page's width, both in page view pixels.
 */
export function isNoteShownInStrip(viewRect, pageViewWidth) {
	return stripShowsNotes && !!viewRect && viewRect[2] >= pageViewWidth - 1;
}

/* ------------------------------------------------------------------ *
 * Annotations written here are not rolled back by a refresh
 * ------------------------------------------------------------------ */

/**
 * After a sync the plugin replaces the reader's annotations with the copies
 * in its database. With automatic sync that can happen while a comment is
 * being written: the copy read from the database a moment earlier is then
 * older than what is on screen, and applying it would take back the last
 * words typed (or bring back an annotation just deleted, or drop one just
 * created).
 *
 * So an annotation written here stays as it is here until its save has
 * safely landed: while it still waits to be saved, and for a few seconds
 * after it was handed to the plugin.
 */
const LOCAL_WRITE_GRACE_MS = 4000;
const localWrites = new Map();

/** Annotations (by id) the reader has just handed to the plugin to save or delete. */
export function noteLocalAnnotationWrites(ids) {
	const now = Date.now();
	for (const [id, time] of localWrites) {
		if (now - time > LOCAL_WRITE_GRACE_MS) localWrites.delete(id);
	}
	for (const id of ids || []) localWrites.set(id, now);
}

/** Ids a refresh from the database must leave alone right now. */
export function annotationsNewerHere(reader) {
	const ids = new Set();
	const waiting = reader?._annotationManager?._unsavedAnnotations;
	if (waiting) {
		for (const id of waiting.keys()) ids.add(id);
	}
	const now = Date.now();
	for (const [id, time] of localWrites) {
		if (now - time <= LOCAL_WRITE_GRACE_MS) ids.add(id);
	}
	return ids;
}

/* ------------------------------------------------------------------ *
 * The page filter for PDFs (set in the note strip's head, per PDF)
 * ------------------------------------------------------------------ */

/** Without a theme the page filter needs a neutral one: it works in its step (pdfjs/patches). */
const IDENTITY_THEME = Object.freeze({ id: "zf-evo-identity", label: "None", background: "#ffffff", foreground: "#000000" });

const rerenderTimers = new WeakMap();

/** Draw the pages of a PDF view again (after the filter changed), shortly. */
function rerenderPages(view, delay = 120) {
	const win = view?._iframeWindow;
	if (!win) return;
	clearTimeout(rerenderTimers.get(view));
	rerenderTimers.set(view, setTimeout(async () => {
		try {
			for (const page of view._pages || []) page.originalPage?.reset?.();
			await win.PDFViewerApplication?.initializedPromise;
			win.PDFViewerApplication?.pdfViewer?.update();
			view._pdfThumbnails?.clear?.();
		}
		catch (e) {
			console.warn("[ZotFlow Evo] Could not draw the pages again:", e);
		}
	}, delay));
}

/**
 * The page filter of the reader's state on both views of a PDF: set where
 * pdf.js reads it (`zfEvoPageFilter`, see pdfjs/patches) and the pages drawn
 * again when it changed. Cheap when nothing changed.
 */
export function applyPdfFilter(reader) {
	if (!reader || reader._type !== "pdf") return;
	const filter = reader._state?.[NOTE_STRIP_STATE]?.pdfFilter;
	const pixels = makePixelFilter(filter);
	const key = pixels ? serializePdfFilter(filter) : "";
	for (const view of [reader._primaryView, reader._secondaryView]) {
		const win = view?._iframeWindow;
		if (!win) continue;
		let changed = win.__zfEvoFilterKey !== key;
		win.__zfEvoFilterKey = key;
		win.zfEvoPageFilter = pixels;
		// The theme step is where the filter works; without a theme (or after
		// the reader set none again) a neutral one stands in.
		if (pixels && !win.theme) {
			win.theme = IDENTITY_THEME;
			changed = true;
		}
		else if (!pixels && win.theme === IDENTITY_THEME) {
			win.theme = null;
			changed = true;
		}
		if (changed) rerenderPages(view);
	}
}

/**
 * A filter written into the PDF (Info dictionary, PDF_INFO_KEY) is used
 * when the plugin has none for this PDF (`pdfFilter: null`), and reported
 * to it to be kept. Once per document.
 */
export async function adoptPdfInfoFilter(reader) {
	if (!reader || reader._type !== "pdf" || reader.__zfEvoInfoChecked) return;
	const settings = reader._state?.[NOTE_STRIP_STATE];
	if (!settings || settings.pdfFilter !== null) return;
	const doc = reader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
	if (!doc) return;
	reader.__zfEvoInfoChecked = true;
	try {
		const { info } = await doc.getMetadata();
		const raw = info?.Custom?.[PDF_INFO_KEY];
		const filter = parsePdfFilter(typeof raw === "string" ? raw : raw?.name);
		if (!filter || isNeutralPdfFilter(filter)) return;
		applyNoteStrip(reader, { pdfFilter: filter });
		reportNoteStrip(reader, { pdfFilter: filter });
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not read the PDF's metadata:", e);
	}
}

/* ------------------------------------------------------------------ *
 * Opening at a search (full-text search in the plugin)
 * ------------------------------------------------------------------ */

/**
 * Open the reader's find bar with `query` and run it: the first match
 * from the current page on is shown. `{ query, caseSensitive, entireWord }`.
 */
export function startFind(reader, find) {
	if (!reader?._updateState || !find?.query) return;
	const key = "primaryViewFindState";
	const current = reader._state?.[key] || {};
	reader._updateState({
		[key]: {
			...current,
			popupOpen: true,
			active: true,
			query: String(find.query),
			caseSensitive: !!find.caseSensitive,
			entireWord: !!find.entireWord,
			highlightAll: true,
			index: null,
			result: null,
		},
	});
}

export { NEUTRAL_PDF_FILTER, isNeutralPdfFilter, pdfFilterOf };
