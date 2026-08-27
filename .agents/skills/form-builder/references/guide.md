# Form Builder Reference Guide

## Overview
Build dynamic forms: validation, conditional fields, multi-step wizards, and file uploads. Use when the goal asks to create forms, add form validation, or build multi-step forms.

## # form-builder

Build dynamic forms: validation, conditional fields, multi-step wizards, and file uploads. Use when the goal asks to create forms, add form validation, or build multi-step forms.

## Goal pattern

form builder validation wizard multi-step file upload input dynamic fields

## Parameters

- framework (choice [default: auto]): UI framework

## Steps

1. [analyst] Define the form schema: fields, types, validation rules, conditional visibility, and default values.

2. [analyst] Choose the form library: react-hook-form, formik, zod validation, or HTML5 native. Install and configure. (after: step-0)

3. [analyst] Implement the form: build field components, add validation, handle multi-step navigation, and manage state. (after: step-1)

4. [analyst] Add file uploads: implement drag-and-drop, preview, progress bars, and server-side storage. (after: step-2)

5. [analyst] Test and polish: verify validation messages, test edge cases, add loading states, and ensure accessibility. (after: step-3)

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
