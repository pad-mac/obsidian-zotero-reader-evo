/**
 * ZotFlow Evo — fork-only reader behaviour.
 *
 * Everything the fork adds to the reader lives in this file and in
 * `common/stylesheets/components/_evo.scss`; the upstream files only call
 * into it. That keeps merges from upstream small. The list of hooks is in
 * FORK.md in the plugin repository (pad-mac/zotflow-evo).
 */

const RESOLVED_STYLE_ID = "zf-evo-resolved-vars";
const TOOLBAR_HIDDEN_CLASS = "zf-evo-toolbar-hidden";

/** Reader state key read by `common/components/reader-ui.js`. */
export const SUPPRESS_ANNOTATION_POPUP_STATE = "zfEvoSuppressAnnotationPopup";

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

/* ------------------------------------------------------------------ *
 * Reader chrome toggled from the Obsidian view header
 * ------------------------------------------------------------------ */

/** Show or hide the reader's toolbar. Layout follows in `_evo.scss`. */
export function applyToolbarHidden(hidden) {
	document.body?.classList.toggle(TOOLBAR_HIDDEN_CLASS, !!hidden);
}

/**
 * Stop the comment popup from opening next to an annotation. The reader
 * keeps tracking which annotation the popup belongs to; only the popup is
 * not rendered, exactly as upstream does while the annotations sidebar is
 * open.
 */
export function applyAnnotationPopupSuppressed(reader, suppressed) {
	reader?._updateState?.({ [SUPPRESS_ANNOTATION_POPUP_STATE]: !!suppressed });
}
