---
name: i18n-setup
description: Set up internationalization (i18n): extract translatable strings, configure a translation framework, and add RTL support. Use when the goal asks to add multi-language support, translations, or localization.
version: 1.0.0
---

# i18n-setup

Set up internationalization (i18n): extract translatable strings, configure a translation framework, and add RTL support. Use when the goal asks to add multi-language support, translations, or localization.

## Goal pattern

i18n internationalization localization translation multilingual language rtl l10n

## Parameters

- framework (choice [default: auto]): i18n framework

## Steps

1. [analyst] Choose an i18n framework: next-intl, react-i18next, vue-i18n, or similar. Install and configure it with the project framework.

2. [analyst] Extract translatable strings: scan source files for hardcoded text, move them to translation files (JSON/YAML), and replace with translation keys. (after: step-1)

3. [analyst] Set up locale management: configure supported locales, locale detection (browser, URL, cookie), and locale switching UI. (after: step-2)

4. [analyst] Handle plurals, dates, numbers, and currencies: configure ICU message format, and add locale-specific formatting for dates and numbers. (after: step-3)

5. [analyst] Add RTL support: configure CSS logical properties, test layout with Arabic/Hebrew, and verify that all components render correctly in both directions. (after: step-4)
