---
name: binary-extensions
description: Detect and handle binary file extensions: identify binary vs text files, handle binary content appropriately, and configure editors/tools to skip binary files. Use when processing mixed file types in a codebase.
version: 1.0.0
---

# binary-extensions

Detect and handle binary file extensions: identify binary vs text files, handle binary content appropriately, and configure editors/tools to skip binary files. Use when processing mixed file types in a codebase.

## Goal pattern

binary extensions file detection text vs binary handling editor configuration skip binary

## Parameters

(none)

## Steps

1. [context-gatherer] Map the file types: what binary extensions exist in the project? What tools process files? What tools need to skip binary files?

2. [planner] Design binary handling:
1. Detection: extension-based + magic byte detection
2. Handling: skip binary files in text processing tools
3. Configuration: .gitattributes for git, .editorconfig for editors
4. MIME types: map extensions to MIME types
5. Tool config: ignore patterns for linters, formatters
6. Documentation: list of binary extensions for reference (after: step-0)

3. [runner] Implement binary handling:
1. Create binary extension list
2. Implement detection function
3. Configure .gitattributes
4. Configure .editorconfig
5. Update tool ignore patterns
6. Test with mixed file types (after: step-1)

4. [reviewer] Verify: binary files correctly detected, text tools skip binary files, git handles binary files correctly. (after: step-2)
