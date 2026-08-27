# Web Scraping Reference Guide

## Overview
Build web scrapers using BeautifulSoup, Playwright, or Puppeteer. Use when the goal asks to scrape, crawl, or extract data from websites.

## # web-scraping

Build web scrapers using BeautifulSoup, Playwright, or Puppeteer. Use when the goal asks to scrape, crawl, or extract data from websites.

## Goal pattern

scrape crawl extract data website html parse

## Parameters

- tool (choice [default: beautifulsoup]): Scraping tool

## Steps

1. [analyst] Identify target URLs and data to extract. Choose scraping tool (BeautifulSoup for simple HTML, Playwright/Puppeteer for dynamic sites).

2. [analyst] Implement HTTP fetching with rate limiting, retry logic, and user-agent rotation. (after: step-0)

3. [analyst] Parse HTML and extract data using CSS selectors or XPath. Handle pagination and nested content. (after: step-1)

4. [analyst] Store extracted data (JSON, CSV, database). Add deduplication and data validation. (after: step-2)

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
