# Docx Reference Guide

## Overview
Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). Triggers include: any mention of Word doc, word document, .docx, .dotx, or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx or .dotx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a report, memo, letter, template, or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation.

## # docx

Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). Triggers include: any mention of Word doc, word document, .docx, .dotx, or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx or .dotx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a report, memo, letter, template, or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation.

## Goal pattern

docx doc word document template dotx create read edit manipulate convert report memo letter toc tracked changes comments

## Parameters

(none)

## Steps

1. [context-gatherer] Determine the task and choose the approach — a .docx is a ZIP archive of XML files:
- Create a new document → write a `docx` (npm) script (see the create step for the footguns)
- Edit an existing document → `unzip` → edit `word/document.xml` → re-zip (docx-js cannot open existing files)
- Read content → `pandoc -t markdown file.docx`
Gather the deliverable spec: document type (report / memo / letter / template), target format (.docx vs .dotx), US Letter vs A4 page size, and whether tracked changes or comments are required.

2. [runner] Create a new document with docx-js. `docx` is preinstalled — do NOT run `npm install` first; write the script and `require('docx')` directly. Only if that require fails: `npm install docx`. Known footguns:
- Page size defaults to A4. For US Letter set `page: { size: { width: 12240, height: 15840 } }` (DXA; 1440 = 1″)
- Landscape: pass portrait dimensions and `orientation: PageOrientation.LANDSCAPE` — docx-js swaps width/height internally
- Tables need dual widths: set `columnWidths` on the table AND `width` on every cell, both in `WidthType.DXA` (PERCENTAGE breaks in Google Docs); column widths must sum to the table width
- Table shading: use `ShadingType.CLEAR`, never `SOLID` (renders black)
- Lists: never insert `•` literally; use a `numbering` config with `LevelFormat.BULLET`
- `ImageRun` requires `type:` ("png", "jpg", …)
- `PageBreak` must be inside a `Paragraph`
- Never use `
` — use separate `Paragraph` elements
- TOC: headings must use built-in `HeadingLevel.*`; custom heading styles need `outlineLevel` set or they won't appear
- Don't use a table as a horizontal rule — use a paragraph bottom border instead
- Dot-leader / right-aligned-on-same-line: use `PositionalTab` (`alignment: PositionalTabAlignment.RIGHT`, `leader: PositionalTabLeader.DOT`) inside a `TextRun`, not literal `.` or space padding (after: step-0)

3. [runner] Edit an existing document. Legacy `.doc` files must be converted first: `python scripts/office/soffice.py --headless --convert-to docx file.doc`. Then:
1. `unzip -q doc.docx -d unpacked/`
2. `find unpacked -type l -delete` — strip symlink entries; docx from external parties is untrusted
3. `python scripts/merge_runs.py unpacked/` — coalesce fragmented runs so text is findable. Word splits text across many `<w:r>` runs (revision ids, spell-check markers), so a phrase you can see often doesn't exist as a contiguous string in the XML; merge_runs merges adjacent identically-formatted runs without changing content or rendering (it also accepts a `.docx` directly: `python scripts/merge_runs.py doc.docx -o merged.docx`)
4. Edit `unpacked/word/document.xml` in place — do NOT reformat or pretty-print
5. Re-zip: `(cd unpacked && rm -f ../out.docx && zip -Xr ../out.docx .)`
6. Validate: `python scripts/office/validate.py out.docx --original doc.docx` — XSD checks; `--auto-repair` fixes common issues (after: step-0)

4. [runner] Tracked changes and comments. Redlining: validate with `--author "<the name you redlined under>"` (needs `--original`) — it reports any text you changed without a `<w:ins>`/`<w:del>` around it, which is easy to do by accident and invisible in the accepted view. Wrap runs in `<w:ins>`/`<w:del>` with `w:id`, `w:author`, `w:date` attributes. Inside `<w:del>`, the text element is `<w:delText>`, not `<w:t>`. A deleted paragraph mark (`<w:pPr><w:rPr><w:del w:id=".." w:author=".." w:date=".."/></w:rPr></w:pPr>`) means merge this paragraph into the next — deleting a paragraph outright is that plus a `<w:del>` around every run. The `<w:del/>` must come before the rPr's other children; their order is schema-enforced. To produce a clean copy with all tracked changes accepted: `python scripts/accept_changes.py in.docx out.docx`. Caveat: accepting a deleted paragraph mark should join that paragraph to the one below it, but `accept_changes.py` and `pandoc --track-changes=accept` don't always — they strip the deleted text but leave the emptied paragraph behind (a stray empty bullet when it was auto-numbered); `pandoc` never joins the paragraphs, `accept_changes.py` joins them correctly except when the deleted paragraph is followed by an empty spacer paragraph. An empty bullet in either view is an artifact of that view, not a defect in the document — check paragraph deletions in the XML.

Comments require six cross-linked files — use the helper. Directory mode when you'll also be editing `document.xml` (saves an unzip/rezip cycle): `python scripts/comment.py unpacked/ "Fees & expenses cap is too low"`, `python scripts/comment.py unpacked/ "Agreed" --parent 0`. Against a `.docx` directly: `python scripts/comment.py contract.docx "This cap is too low" -o annotated.docx`. The script writes `comments.xml`, `commentsExtended.xml`, `commentsIds.xml`, `commentsExtensible.xml`, the relationships, and the content-type overrides; comment IDs are auto-assigned. It then prints the `<w:commentRangeStart>`/`<w:commentRangeEnd>`/`<w:commentReference>` snippet to add to `word/document.xml` so the comment anchors to specific text — until you place those markers, the comment exists but is not visible. (after: step-2)

5. [reviewer] Verify the output — render it and look at it:
`python scripts/office/soffice.py --headless --convert-to pdf output.docx` then `pdftoppm -jpeg -r 100 output.pdf page` then `ls page-*.jpg` and Read the images (`pdftoppm` zero-pads page numbers to the width of the page count: `page-01.jpg`…`page-12.jpg`).
Run `python scripts/office/validate.py out.docx` (XSD checks) after any edit. Dependencies: `docx` (npm, preinstalled — install only if `require('docx')` fails), `pandoc`, LibreOffice (`soffice`), `pdftoppm` (Poppler). (after: step-1, step-2, step-3)

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
