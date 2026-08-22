---
name: web-scraping
description: Build web scrapers using BeautifulSoup, Playwright, or Puppeteer. Use when the goal asks to scrape, crawl, or extract data from websites.
version: 1.0.0
---

# web-scraping

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
