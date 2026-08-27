# Legal Compliance Reference Guide

## Overview
Add legal compliance: privacy policy, terms of service, cookie consent, GDPR/CCPA data handling, and cookie banners. Use when the goal asks to add legal pages, privacy policy, cookie consent, or compliance with privacy regulations.

## # legal-compliance

Add legal compliance: privacy policy, terms of service, cookie consent, GDPR/CCPA data handling, and cookie banners. Use when the goal asks to add legal pages, privacy policy, cookie consent, or compliance with privacy regulations.

## Goal pattern

legal compliance privacy policy terms of service cookie consent gdpr ccpa cookie banner gdpr

## Parameters

- regulation (choice [default: auto]): Target regulation

## Steps

1. [analyst] Audit data collection: identify what personal data is collected (forms, cookies, analytics), how it is stored, and who it is shared with.

2. [analyst] Create a cookie consent banner: implement a GDPR-compliant consent manager that blocks non-essential cookies until explicit consent is given. (after: step-1)

3. [analyst] Draft privacy policy and terms of service: use a template generator or legal framework, customize for the app specific data practices. (after: step-2)

4. [analyst] Implement data export and deletion (right to be forgotten): build endpoints for users to download or delete their personal data. (after: step-3)

5. [analyst] Add consent logging: record when and what the user consented to. Set up a data processing agreement template for third-party services. (after: step-4)

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
