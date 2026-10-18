import Reader from "./common/reader";
import zoteroFTL from '../locales/en-US/zotero.ftl';
import readerFTL from '../locales/en-US/reader.ftl';
import brandFTL from '../locales/en-US/brand.ftl';
import { ObsidianBridge } from "./obsidian-adapter";
import {
	annotationsNewerHere,
	applyNoteStrip,
	noteLocalAnnotationWrites,
	applyResolvedObsidianVariables,
	applyToolbarHidden,
	refreshResolvedObsidianVariables,
	startFind,
	syncThemeFollowers,
} from "./obsidian-evo";

/**
 * -----------------------------------------------------------
 * Adapter for the reader
 * -----------------------------------------------------------
 */

export default class ZoteroReaderAdapter {
	reader;

	listeners = new Set();

	disposePromise;

	on(cb) {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	emit(e) {
		this.listeners.forEach((l) => l(e));
	}

	secondaryViewInitialized = false;

	// ZotFlow Evo: reader chrome toggled from the Obsidian view header.
	toolbarHidden = false;

	async createReader(opts) {
		const defaults = {
			ftl: opts.ftl || [zoteroFTL, readerFTL, brandFTL],
			readOnly: false,
			annotations: [],
			primaryViewState: {},
			sidebarWidth: 240,
			sidebarOpen: false,
			toolbarPlaceholderWidth: 0,
			showAnnotations: true,
			// ZotFlow's host bridge already suppresses progress after close/reconnect.
			getSDTPack: ({ onProgress } = {}) => ObsidianBridge.getSDTPack({
				onProgress,
				password: this.reader?._password ?? opts.password,
			}),
			onOpenContextMenu: (params) => {
				this.reader.openContextMenu(params);
			},
			onAddToNote: () => {
				this.emit({ type: "addToNote" });
			},
			onSaveAnnotations: (annotations) => {
				console.log("Save annotations", annotations);
				// ZotFlow Evo: see refreshAnnotations()
				noteLocalAnnotationWrites(annotations.map(x => x.id));
				this.emit({ type: "annotationsSaved", annotations });
			},
			onUpdateAnnotation: (annotation) => {
				this.emit({ type: "annotationUpdated", annotation });
			},
			onDeleteAnnotations: (ids) => {
				// ZotFlow Evo: see refreshAnnotations()
				noteLocalAnnotationWrites(ids);
				this.emit({ type: "annotationsDeleted", ids });
			},
			onChangeViewState: (state, primary) => {
				if (state && !this.reader._state.splitType) {
					this.secondaryViewInitialized = false;
					this.reader._secondaryViewContainer.style.opacity = "0";
				}

				if (
					state &&
					!this.secondaryViewInitialized &&
					this.reader._state.splitType
				) {
					this.adoptObsidianStyles(
						window.OBSIDIAN_THEME_VARIABLES,
						this.reader._secondaryView?._iframeWindow.document
					);
					this.applyColorScheme(
						opts.colorScheme,
						this.reader._secondaryView?._iframeWindow.document
					);
					this.applyPageBackgroundColor(this.reader._secondaryView?._iframeWindow.document);
					this.reader._secondaryViewContainer.style.opacity = "1";
					this.secondaryViewInitialized = true;
				}

				this.emit({ type: "viewStateChanged", state, primary });
			},
			onOpenTagsPopup: (annotationID, left, top) => {
				this.emit({ type: "openTagsPopup", annotationID, left, top });
			},
			onClosePopup: (data) => {
				this.emit({ type: "closePopup", data });
			},
			onOpenLink: (url) => {
				this.emit({ type: "openLink", url });
			},
			onToggleSidebar: (open) => {
				this.emit({ type: "sidebarToggled", open });
			},
			onChangeSidebarView: (view) => {
			},
			onChangeSidebarWidth: (width) => {
			},
			onSetDataTransferAnnotations: (
				dataTransfer,
				annotations,
				fromText
			) => {
				ObsidianBridge.handleSetDataTransferAnnotations(dataTransfer, annotations, fromText);
			},
			onConfirm: (title, text, confirmationButtonTitle) => {
				this.emit({
					type: "confirm",
					title,
					text,
					confirmationButtonTitle,
				});
			},
			onRotatePages: (pageIndexes, degrees) => {
				this.emit({ type: "rotatePages", pageIndexes, degrees });
			},
			onDeletePages: (pageIndexes, degrees) => {
				this.emit({ type: "deletePages", pageIndexes, degrees });
			},
			onToggleContextPane: () => {
				this.emit({ type: "toggleContextPane" });
			},
			onTextSelectionAnnotationModeChange: (mode) => {
				this.emit({ type: "textSelectionAnnotationModeChanged", mode });
			},
			onSaveCustomThemes: (customThemes) => {
				this.reader.setCustomThemes(customThemes);
				this.emit({ type: "saveCustomThemes", customThemes });
			},
			onSetLightTheme: (theme) => {
				this.reader.setLightTheme(theme);
				this.emit({ type: "setLightTheme", theme });
			},
			onSetDarkTheme: (theme) => {
				this.reader.setDarkTheme(theme);
				this.emit({ type: "setDarkTheme", theme });
			}
		};

		const config = { ...defaults, ...opts };

		this.applyColorScheme(opts.colorScheme, document);

		// ZotFlow Evo: Obsidian's computed variables, before the page theme and
		// the toolbar colour are derived from them.
		refreshResolvedObsidianVariables([document]);
		this.setToolbarHidden(opts.toolbarHidden);
		// A setting changed while the reader was still loading is the newer one.
		this.noteStrip = { ...opts.noteStrip, ...this.noteStrip };
		
		// Check if obsidian theme is already in customThemes, if not add it
		if (config.customThemes.some((t) => t.id === "obsidian")) {
			config.customThemes = config.customThemes?.map(
				(theme) => {
					if (theme.id === "obsidian") {
						return this.generateObsidianTheme();
					}
					return theme;
				}
			);
		}
		else
		{
			config.customThemes.push(this.generateObsidianTheme());
		}

		// Build data argument from Source
		if (
			!config.data ||
			!(config.data.buf || config.data.url) ||
			!config.type
		) {
			throw new Error(
				"Reader data is required (one of data.buf and data.url, and data.type must be provided in options)"
			);
		}
		
		// Apply sidebar position
		if (config.sidebarPosition === "end") {
			document.body.classList.toggle("sidebar-position-end", true);
		}

		// Create the reader
		this.reader = new Reader(config);
		await this.reader.initializedPromise;
		window._reader = this.reader;

		// Wire the mobile "tap outside to close" backdrop (see
		// index.obsidian.reader.html + stylesheets/components/_responsive.scss).
		// The backdrop only receives pointer events while it is visible (narrow
		// viewport + sidebar open), so a tap on it always means "dismiss the
		// drawer". Mirrors the sidebar-toggle button: update state + emit.
		const sidebarBackdrop = document.getElementById("zf-sidebar-backdrop");
		if (sidebarBackdrop) {
			sidebarBackdrop.addEventListener("pointerdown", () => {
				this.reader.toggleSidebar(false);
				this.emit({ type: "sidebarToggled", open: false });
			});
		}

		// adopt obsidian styles
		this.adoptObsidianStyles(
			window.OBSIDIAN_THEME_VARIABLES,
			this.reader._primaryView._iframeWindow.document
		);
		this.applyColorScheme(
			opts.colorScheme,
			this.reader._primaryView._iframeWindow.document
		);
		this.applyPageBackgroundColor(this.reader._primaryView._iframeWindow.document);

		this.reader._primaryViewContainer.style.opacity = "1";

		if (this.reader._state.splitType) {
			this.adoptObsidianStyles(
				window.OBSIDIAN_THEME_VARIABLES,
				this.reader._secondaryView?._iframeWindow.document
			);
			this.applyColorScheme(
				opts.colorScheme,
				this.reader._secondaryView?._iframeWindow.document
			);
			this.applyPageBackgroundColor(this.reader._secondaryView?._iframeWindow.document);
			this.reader._secondaryViewContainer.style.opacity = "1";
			this.secondaryViewInitialized = true;
		}

		// ZotFlow Evo: needs the PDF view's document, styled as above.
		this.setNoteStrip(this.noteStrip);

		this.emit({ type: "ready" });
	}

	applyColorSchemeForAll(colorScheme) {
		// ZotFlow Evo: also called when Obsidian's CSS changed but the scheme
		// did not, so read the variables again.
		refreshResolvedObsidianVariables([
			document,
			this.reader?._primaryView?._iframeWindow?.document,
			this.reader?._secondaryView?._iframeWindow?.document,
		]);
		this.applyColorScheme(colorScheme, document);
		this.applyColorScheme(colorScheme, this.reader?._primaryView?._iframeWindow.document);
		this.applyColorScheme(colorScheme, this.reader?._secondaryView?._iframeWindow.document);

		const newCustomThemes = this.reader._state.customThemes?.map(
			(theme) => {
				if (theme.id === "obsidian") {
					return this.generateObsidianTheme();
				}
				return theme;
			}
		);

		this.reader.setColorScheme(colorScheme)
		this.reader.setCustomThemes(newCustomThemes);
		this.applyPageBackgroundColor(this.reader?._primaryView?._iframeWindow.document);
		this.applyPageBackgroundColor(this.reader?._secondaryView?._iframeWindow.document);
		// ZotFlow Evo: documents the fork created follow the reader document.
		syncThemeFollowers();
	}

	applyColorScheme(colorScheme, document) {
		if (!document) return;

		document.documentElement.classList.toggle(
			"obsidian-theme-dark",
			colorScheme === "dark"
		);
		document.documentElement.classList.toggle(
			"obsidian-theme-light",
			colorScheme === "light"
		);
	}

	adoptObsidianStyles(obsidianThemeVariables, document) {
		// ZotFlow Evo: `document` is the view iframe's document here.
		applyResolvedObsidianVariables(document);
		if (!obsidianThemeVariables || !document) return;
		const varsStyle = document.createElement("style");
		varsStyle.textContent = Object.entries(obsidianThemeVariables)
			.map(
				([sel, map]) =>
					`${sel}{${Object.entries(map)
						// Filter out variables that cause issues in the reader
						.filter(([k, _]) => ![
							"--page-border"
						].includes(k))
						.map(([k, v]) => `${k}:${v};`)
						.join("")}}`
			)
			.join("");

		const scrollbarStyle = document.createElement("style");
		scrollbarStyle.textContent = `
				::-webkit-scrollbar {
					background-color: var(--scrollbar-bg);
					width: var(--scrollbar-width);
					height: var(--scrollbar-height);
					-webkit-border-radius: var(--scrollbar-radius);
					background-color: transparent;
				}

				::-webkit-scrollbar-track {
					background-color: transparent;
				}

				::-webkit-scrollbar-thumb {
					background-color: var(--scrollbar-thumb-bg);
					-webkit-border-radius: var(--scrollbar-radius);
					background-clip: padding-box;
					border: 2px solid transparent;
					border-width: var(--scrollbar-border-width);
					min-height: 45px;
				}

				::-webkit-scrollbar-thumb:active {
					-webkit-border-radius: var(--scrollbar-radius);
				}

				::-webkit-scrollbar-thumb:hover,
				::-webkit-scrollbar-thumb:active {
					background-color: var(--scrollbar-active-thumb-bg);
				}

				::-webkit-scrollbar-corner {
					background: transparent;
				}
				@supports not selector(::-webkit-scrollbar) {
					:root {
						scrollbar-width: thin;
						scrollbar-color: var(--scrollbar-thumb-bg) var(--scrollbar-bg);
					}
				}`;

		document.head.prepend(scrollbarStyle);
		document.head.prepend(varsStyle);
	}

	applyPageBackgroundColor(document) {
		if (!document) return;

		const toolbarColor = getComputedStyle(window.document.documentElement)
			.getPropertyValue("--color-toolbar").trim();
		if (toolbarColor) {
			document.documentElement.style.setProperty('--pdf-page-background-color', toolbarColor);
		}
	}

	generateObsidianTheme() {
		const expandShortHex = (hex) => {
			// Convert #abc to #aabbcc
			return hex.replace(
				/^#([a-f\d])([a-f\d])([a-f\d])$/i,
				(m, r, g, b) => "#" + r + r + g + g + b + b
			);
		};

		const convertAnyColorToHex = (color) => {
			// Already hex
			if (color.startsWith("#")) {
				return color.length === 4 ? expandShortHex(color) : color;
			}

			// Named colors, rgb(), rgba(), hsl(), etc.
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 1;
			const ctx = canvas.getContext("2d");

			ctx.fillStyle = color;
			ctx.fillRect(0, 0, 1, 1);

			const imageData = ctx.getImageData(0, 0, 1, 1).data;
			const r = imageData[0];
			const g = imageData[1];
			const b = imageData[2];

			return (
				"#" +
				((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
			);
		};

		// Fallback to parent window's computed styles
		const getVariableFallback = (name) => {
			const parent = window.findParentWindow();
			if (!parent) return null;
			return parent.getComputedStyle(parent.document.body).getPropertyValue(name)?.trim();
		};

		const computedStyle = getComputedStyle(document.documentElement);
		let background = computedStyle.getPropertyValue("--background-primary")?.trim();
		let foreground = computedStyle.getPropertyValue("--text-normal")?.trim();

		// Fallback if getComputedStyle fails
		if (!background || background === "") {
			background = getVariableFallback("--background-primary");
		}
		if (!foreground || foreground === "") {
			foreground = getVariableFallback("--text-normal");
		}

		return {
			background: convertAnyColorToHex(background 
				|| (document.documentElement.classList.contains("obsidian-theme-dark") ? "#000000" : "#FFFFFF")),
			foreground: convertAnyColorToHex(foreground 
				|| (document.documentElement.classList.contains("obsidian-theme-dark") ? "#FFFFFF" : "#000000")),
			id: "obsidian",
			label: "Obsidian",
		};
	}

	// ZotFlow Evo
	setToolbarHidden(hidden) {
		this.toolbarHidden = !!hidden;
		applyToolbarHidden(this.toolbarHidden);
	}

	// ZotFlow Evo: `{ visible, collapsed, width, banner, highlights }`, any subset.
	setNoteStrip(settings) {
		if (!settings) return;
		this.noteStrip = { ...this.noteStrip, ...settings };
		applyNoteStrip(this.reader, this.noteStrip);
	}

	addAnnotation(annotation) {
		if (this.reader) {
			this.reader._annotationManager.addAnnotation(annotation);
		}
	}

	async refreshAnnotations(annotations) {
		if (this.reader) {
			// ZotFlow Evo: what was written here a moment ago is newer than
			// the copy this refresh carries; leave it as it is here.
			const newerHere = annotationsNewerHere(this.reader);
			annotations = annotations.filter((a) => !newerHere.has(a.id));
			// Unset all annotations not in the new list, and set the new ones
			const newIDs = new Set(annotations.map((a) => a.id));
			const annotationsToRemove = this.reader._annotationManager._annotations.filter(x => !newIDs.has(x.id) && !newerHere.has(x.id)).map(x => x.id);
			this.reader._annotationManager.unsetAnnotations(annotationsToRemove);
			this.reader.setAnnotations(annotations);
		}
	}

	async navigate(location) {
		if (this.reader) {
			// ZotFlow Evo: `evoFind` opens the find bar at a search (the
			// plugin's full-text search); the rest is a place, as before.
			const { evoFind, ...place } = location || {};
			if (Object.keys(place).length) this.reader.navigate(place, { behavior: "smooth" });
			if (evoFind) startFind(this.reader, evoFind);
		}
	}

	async dispose() {
		if (this.disposePromise) return this.disposePromise;

		this.disposePromise = (async () => {
			const reader = this.reader;
			try {
				// Obsidian owns the iframe lifecycle. Release its SDT overlays here
				// before the existing Reader cleanup clears the references to them.
				try {
					reader?._secondarySDTView?.destroy();
					reader?._primarySDTView?.destroy();
				}
				finally {
					await reader?.destroy?.();
				}
			}
			finally {
				if (window._reader === reader) {
					delete window._reader;
				}
				this.reader = undefined;
				this.secondaryViewInitialized = false;
				this.listeners.clear();
			}
		})();

		return this.disposePromise;
	}
}
