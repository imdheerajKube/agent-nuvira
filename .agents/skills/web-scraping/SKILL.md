---
name: web-scraping
description: Build web scrapers using BeautifulSoup, Playwright, or Puppeteer. Use when the goal asks to scrape, crawl, or extract data from websites.
version: 2.0.0
whenToUse: Data extraction, price monitoring, content aggregation, lead generation, research
whenNotToUse: API integration (use api-call), real-time monitoring (use webhooks), simple HTTP requests
---

# Web Scraping

Build web scrapers with production patterns.

## Goal pattern

web scraping crawl extract data beautifulsoup playwright puppeteer selenium

## Parameters

- framework (choice [default: playwright]): Scraping framework
- output (choice [default: json]): Output format
- proxy (boolean [default: false]): Use proxy rotation

## Steps

### Step 1: [analyst] — Analyze scraping requirements

```bash
# Check target website
curl -I https://example.com

# Check robots.txt
curl -s https://example.com/robots.txt

# Check scraping tools
python3 -c "import playwright; print('playwright installed')" 2>/dev/null
python3 -c "import bs4; print('beautifulsoup installed')" 2>/dev/null
node -e "require('puppeteer')" 2>/dev/null && echo "puppeteer installed"
```

- What data to extract? (text, images, links, tables)
- What website structure? (static HTML, JavaScript-rendered, SPA)
- What rate limits? (respect robots.txt, add delays)
- What output format? (JSON, CSV, database)

### Step 2: [analyst] — Build scraper

**Playwright scraper:**
```python
# src/scraper/playwright_scraper.py
import asyncio
from playwright.async_api import async_playwright
import json
from pathlib import Path

class WebScraper:
    def __init__(self, headless=True):
        self.headless = headless
        self.results = []
    
    async def scrape_page(self, url: str, selectors: dict) -> dict:
        """Scrape a single page."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=self.headless)
            page = await browser.new_page()
            
            # Add stealth plugins
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined})
            """)
            
            await page.goto(url, wait_until='networkidle')
            
            # Extract data
            data = {}
            for key, selector in selectors.items():
                elements = await page.query_selector_all(selector)
                data[key] = [await el.inner_text() for el in elements]
            
            await browser.close()
            return data
    
    async def scrape_multiple(self, urls: list, selectors: dict) -> list:
        """Scrape multiple pages with rate limiting."""
        results = []
        for url in urls:
            try:
                data = await self.scrape_page(url, selectors)
                results.append({'url': url, 'data': data})
                await asyncio.sleep(2)  # Rate limiting
            except Exception as e:
                results.append({'url': url, 'error': str(e)})
        return results

# Usage
async def main():
    scraper = WebScraper()
    selectors = {
        'titles': 'h1.title',
        'prices': '.price',
        'descriptions': '.product-description'
    }
    results = await scraper.scrape_multiple(urls, selectors)
    
    with open('output.json', 'w') as f:
        json.dump(results, f, indent=2)

asyncio.run(main())
```

**BeautifulSoup scraper:**
```python
# src/scraper/bs4_scraper.py
import requests
from bs4 import BeautifulSoup
import csv
import time

class SimpleScraper:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
    
    def scrape(self, url: str, selectors: dict) -> dict:
        """Scrape a page with BeautifulSoup."""
        response = self.session.get(url)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        data = {}
        for key, selector in selectors.items():
            elements = soup.select(selector)
            data[key] = [el.get_text(strip=True) for el in elements]
        
        return data
    
    def scrape_to_csv(self, urls: list, selectors: dict, output: str):
        """Scrape multiple pages to CSV."""
        with open(output, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=selectors.keys())
            writer.writeheader()
            
            for url in urls:
                data = self.scrape(url, selectors)
                writer.writerow(data)
                time.sleep(1)  # Respect rate limits

# Usage
scraper = SimpleScraper()
urls = ['https://example.com/page1', 'https://example.com/page2']
selectors = {'title': 'h1', 'content': '.article-body'}
scraper.scrape_to_csv(urls, selectors, 'output.csv')
```

### Step 3: [analyst] — Execute scraper

```bash
# Run Playwright scraper
python src/scraper/playwright_scraper.py

# Run BeautifulSoup scraper
python src/scraper/bs4_scraper.py

# Check output
cat output.json | jq '.[0]'
wc -l output.csv

# Verify data quality
python -c "
import json
with open('output.json') as f:
    data = json.load(f)
print(f'Items scraped: {len(data)}')
print(f'Successful: {len([d for d in data if \"error\" not in d])}')
"
```

### Step 4: [analyst] — Verify scraper works

```bash
# Check output file
ls -la output.*

# Verify data completeness
python -c "
import json
with open('output.json') as f:
    data = json.load(f)

for item in data[:5]:
    print(f\"URL: {item['url']}\")
    print(f\"Data keys: {list(item['data'].keys())}\")
    print()
"

# Test with different inputs
curl -s https://example.com | grep -o '<title>[^<]*</title>'
```

**Verification checklist:**
- [ ] Scraper extracts correct data
- [ ] Rate limiting respected
- [ ] Error handling works
- [ ] Output format valid
- [ ] No IP blocks
- [ ] Data quality acceptable
- [ ] Storage space managed

## Reference Documents

Load deep-dive content with `skill_view('web-scraping', 'references/guide.md')`.
