# Design System Reference Guide

## Overview
Build a component library / design system: tokens, base components, composition patterns, documentation, and testing. Use when the goal asks to create a design system, component library, or shared UI kit.

## # design-system

Build a component library / design system: tokens, base components, composition patterns, documentation, and testing. Use when the goal asks to create a design system, component library, or shared UI kit.

## Goal pattern

design system component library ui kit tokens storybook tailwind shadcn radix

## Parameters

- framework (choice [default: auto]): UI framework

## Steps

1. [analyst] Define design tokens: color palette, typography scale, spacing units, border radius, shadows. Export as CSS variables and JS/TS constants.

2. [analyst] Build base components: Button, Input, Select, Checkbox, Radio, Switch, Textarea, Modal. Each with variants (size, color), states (disabled, loading, error), and accessibility. (after: step-1)

3. [analyst] Build composition components: Card, Table, Tabs, Accordion, Dropdown, Tooltip, Toast. Each using the base components. (after: step-2)

4. [analyst] Set up Storybook (or similar): write stories for every component with all variants and states. Add interaction tests. (after: step-3)

5. [analyst] Publish the library: configure build (tsup/rollup), add package.json exports, write a README with usage examples, and publish to npm. (after: step-4)

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
