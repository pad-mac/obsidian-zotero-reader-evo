import ZoteroReaderAdapter from "./index.obsidian.reader.js";
import {
	disposeBridge,
	initBridge,
	ObsidianBridge,
	registerChildAPI,
} from "./obsidian-adapter.js";
import { connect, WindowMessenger } from "penpal";
import { initializeEditorMathJax } from "./obsidian-mathjax.js";

/**
 * -----------------------------------------------------------
 * Bridge with the obsidian
 * -----------------------------------------------------------
 */

(async () => {
	await initializeEditorMathJax(window, window.findParentWindow());

	const messenger = new WindowMessenger({
		remoteWindow: window.findParentWindow(),
		allowedOrigins: ["*"],
	});

	const connection = connect({
		messenger,
	});
	const parent = await connection.promise;
	parent.shakehand().then(() => {
		initBridge();

		const readerAdapter = new ZoteroReaderAdapter();
		let destroyed = false;
		const childAPI = {
			async initReader(opts) {
				if (destroyed) return false;
				readerAdapter.on((evt) => ObsidianBridge.handleEvent(evt));
				// If the parent passed us an ArrayBuffer, we need to transfer the realm under us
				if (opts.data.buf) {
					const childCopy = new Uint8Array(opts.data.buf.length);
					childCopy.set(opts.data.buf);

					await readerAdapter.createReader({
						...opts,
						data: { buf: childCopy, url: opts.data.url },
					});
				} else {
					await readerAdapter.createReader(opts);
				}
				return true;
			},
			async setColorScheme(colorScheme) {
				readerAdapter.applyColorSchemeForAll(colorScheme);
				return true;
			},
			async addAnnotation(annotation) {
				readerAdapter.addAnnotation(annotation);
				return true;
			},
			async refreshAnnotations(annotations) {
				readerAdapter.refreshAnnotations(annotations);
				return true;
			},
			async navigate(location) {
				readerAdapter.navigate(location);
				return true;
			},
			// ZotFlow Evo
			async setToolbarHidden(hidden) {
				readerAdapter.setToolbarHidden(hidden);
				return true;
			},
			// ZotFlow Evo
			async setAnnotationPopupSuppressed(suppressed) {
				readerAdapter.setAnnotationPopupSuppressed(suppressed);
				return true;
			},
			async destroy() {
				if (destroyed) return true;
				destroyed = true;
				try {
					await readerAdapter.dispose();
				}
				finally {
					// ZotFlow: The direct child API replaced Penpal RPC after the
					// handshake; release its listener and parent-realm references.
					disposeBridge();
					connection.destroy();
				}
				return true;
			},
		};

		registerChildAPI(childAPI);
	});
})();
