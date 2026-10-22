import React, { useId, useEffect, useRef } from "react";
import { ObsidianBridge } from "../../../obsidian-adapter";
import cx from "classnames";
import CommentDisplay from "./comment-display";

// ZotFlow Evo: focus an editor made by `createAnnotationEditor()`, the cursor at the end.
function focusAtEnd(ed, win) {
	try {
		win.focus();
		const cm = ed?.activeCM;
		if (cm?.dispatch && cm.state?.doc) {
			cm.dispatch({ selection: { anchor: cm.state.doc.length } });
		}
		cm?.focus?.();
	}
	catch (e) {
		console.warn("[ZotFlow Evo] Could not focus the comment:", e);
	}
}

function ObsidianEditor(props) {
	let editorRef = useRef();
	const editorId = `${props.id}_${useId()}`;
	const [editor, setEditor] = React.useState(null);
	// ZotFlow Evo: the editor is made once; its changes go to the props of now.
	const onChangeRef = useRef(props.onChange);
	onChangeRef.current = props.onChange;

	const options = {
		value: props.text,
		placeholder: props.placeholder,
		cls: "content",
		onChange: (update) => onChangeRef.current(update.state.doc.toString()),
	};

	useEffect(() => {
		if (props.readOnly) return;
		const ed = ObsidianBridge.createAnnotationEditor(editorRef.current, options);
		setEditor(ed);
		return () => {
			ed.onunload();
			setEditor(null);
		};
	}, [props.readOnly]);

	// ZotFlow Evo: the annotation popup's comment takes the keyboard at once,
	// the cursor at its end, as in Zotero — also when the popup moves on to
	// another annotation. After the click that opened it has settled (it
	// would take the focus back to the pages).
	useEffect(() => {
		if (!props.autoFocus || !editor) return;
		const win = editorRef.current?.ownerDocument?.defaultView || window;
		const timer = win.setTimeout(() => focusAtEnd(editor, win), 0);
		return () => win.clearTimeout(timer);
	}, [editor, props.id, props.autoFocus]);

	useEffect(() => {
		if (editor) {
			editor.set(props.text);
		}
	}, [props.text, editor]);

	if (props.readOnly) {
		return <CommentDisplay {...props} />;
	}

	return (
		<div className={cx("editor")} style={{ fontSize:"1em" }}>
			<div id={editorId} style={{ fontSize: "1em" }} ref={editorRef} />
		</div>
	);
}

export default ObsidianEditor;
