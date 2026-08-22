---
name: pdf-generate
description: Generate PDFs from HTML, Markdown, or data: invoices, reports, certificates, and documents. Use when the goal asks to create, generate, or export PDF files.
version: 1.0.0
---

# pdf-generate

Generate PDFs from HTML, Markdown, or data: invoices, reports, certificates, and documents. Use when the goal asks to create, generate, or export PDF files.

## Goal pattern

pdf generate create export invoice report document print html markdown

## Parameters

- library (choice [default: auto]): PDF library

## Steps

1. [analyst] Identify the PDF type: invoice, report, certificate, receipt. Choose the generation library (puppeteer, pdfkit, jspdf).

2. [analyst] Design the layout: create an HTML template or programmatic layout with headers, footers, tables, and page breaks. (after: step-0)

3. [analyst] Implement generation: wrap the library with a typed generatePdf() function that accepts data and returns a Buffer. (after: step-1)

4. [analyst] Add styling: CSS for print media, page margins, fonts, and colors. Test with different data sizes. (after: step-2)

5. [analyst] Test and verify: generate sample PDFs, check file size, validate content, and test edge cases (empty data, long text). (after: step-3)
