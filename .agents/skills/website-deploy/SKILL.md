---
name: website-deploy
description: Deploy a static site or built web app to a hosting provider (Cloudflare Pages, Netlify, Vercel, GitHub Pages, AWS S3+CloudFront, Azure Static Web Apps, Firebase Hosting) and verify the live URL. Use when the goal asks to deploy, publish, host, or ship a website or web app to a hosting provider.
version: 1.0.0
---

# website-deploy

Deploy a static site or built web app to a hosting provider (Cloudflare Pages, Netlify, Vercel, GitHub Pages, AWS S3+CloudFront, Azure Static Web Apps, Firebase Hosting) and verify the live URL. Use when the goal asks to deploy, publish, host, or ship a website or web app to a hosting provider.

## Goal pattern

deploy publish host website web app site landing page cloudflare pages netlify vercel github pages hosting static

## Parameters

- provider (choice (required)): Hosting provider to deploy to: cloudflare-pages, netlify, vercel, github-pages, aws-s3, azure-swa, or firebase-hosting
- projectName (string): Provider project/site/bucket name
- outputDir (file-path [default: .]): Directory containing the built site files (default: current directory)
- productionBranch (string [default: main]): Production branch for the hosting project (default: main)

## Steps

1. [context-gatherer] Inspect the site directory to identify the built output (index.html or a framework build folder like dist/ or build/), detect which hosting CLIs are installed and authenticated on this machine (wrangler, netlify, vercel, gh, aws, firebase), and report the site type and output directory.

2. [runner] Ensure the hosting project is ready for the target provider (skip creation if the project already exists):
- cloudflare-pages: wrangler 4 does NOT auto-create Pages projects, so create it first (ignore the error if it already exists): Run `wrangler pages project create {{projectName}} --production-branch {{productionBranch}}`
- netlify: no setup needed — the CLI creates the site on first deploy
- vercel: no setup needed — the CLI creates the project on first deploy
- github-pages: ensure the folder is a git repo with a remote and a .nojekyll file: Run `git init 2>/dev/null; touch .nojekyll; git add -A && git commit -m "init" 2>/dev/null || true`
- aws-s3: ensure the S3 bucket exists with static website hosting enabled: Run `aws s3api create-bucket --bucket {{projectName}} --region us-east-1 2>/dev/null || true; aws s3 website s3://{{projectName}} --index-document index.html --error-document 404.html 2>/dev/null || true`
- azure-swa: no setup needed — the CLI creates the app
- firebase-hosting: ensure firebase.json exists with a public directory set to {{outputDir}} (create it if missing). (after: step-0)

3. [runner] Deploy the built site in '{{outputDir}}' to the '{{provider}}' provider and capture the deployment URL printed by the command:
- cloudflare-pages: Run `wrangler pages deploy {{outputDir}} --project-name {{projectName}}`
- netlify: Run `npx netlify-cli deploy --prod --dir={{outputDir}}`
- vercel: Run `npx vercel --prod --yes`
- github-pages: Run `git add -A && git commit -m "deploy: website" && git push origin {{productionBranch}}` (or `npx gh-pages -d {{outputDir}}` to push a gh-pages branch)
- aws-s3: Run `aws s3 sync {{outputDir}} s3://{{projectName}} --delete` (deployment URL is https://{{projectName}}.s3-website-<region>.amazonaws.com)
- azure-swa: Run `npx @azure/static-web-apps-cli deploy --env production`
- firebase-hosting: Run `npx firebase-tools deploy --only hosting` (after: step-1)

4. [runner] Verify the deployed site is live: fetch the deployment URL printed by the deploy step with curl and confirm it returns HTTP 200 and the site HTML. For example: Run `curl -s -o /dev/null -w "%{http_code}" <deployed-url>` then Run `curl -s <deployed-url> | head -c 400` (after: step-2)

5. [reviewer] Review the deployment: confirm the live URL returns HTTP 200 with the expected page content, and that the deployed files (HTML/CSS/JS) are present and correctly referenced. (after: step-3)
