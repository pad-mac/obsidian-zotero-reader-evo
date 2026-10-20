# ZotFlow Evo: patches to Zotero's pdf.js

`pdfjs/pdf.js` is Zotero's pdf.js (a submodule we do not fork). Changes we
need in it are kept here as patches; `pdfjs/build` applies each one before
building (and leaves a tree that already has it alone).

| Patch | What | Why |
| --- | --- | --- |
| `0001-zf-evo-page-filter.patch` | `src/display/blender/blender.js`: when the PDF view's window has `zfEvoPageFilter` (`{ image(data), color(rgb) }`), images and colours pass through it before the theme (`Blender`) maps them. | The page filter (contrast, white threshold, saturation) has to change the pixels before the theme decides what is the page's background, so paper it whitens gets the theme's background colour. Set by `src/obsidian-evo.js`. |

After updating the submodule, check that each patch still applies
(`git -C pdfjs/pdf.js apply --check ../patches/<patch>`), and rebuild.
