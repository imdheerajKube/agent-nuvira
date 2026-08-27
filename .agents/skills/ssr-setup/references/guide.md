# Ssr Setup Reference Guide

## Overview
Set up server-side rendering: Next.js, Nuxt, or SvelteKit SSR configuration, hydration, streaming, and caching strategies. Use when the goal is to improve initial load performance and SEO with server rendering.

## # ssr-setup

Set up server-side rendering: Next.js, Nuxt, or SvelteKit SSR configuration, hydration, streaming, and caching strategies. Use when the goal is to improve initial load performance and SEO with server rendering.

## Goal pattern

SSR server side rendering Next.js Nuxt SvelteKit hydration streaming caching SEO performance

## Steps

0. [context-gatherer] Map the SSR needs: what framework? What pages need SSR vs static? What data fetching patterns? Caching requirements?

1. [planner] Design SSR architecture:
1. Framework config: Next.js app router, Nuxt server routes, SvelteKit load functions
2. Data fetching: server components, getServerSideProps, API routes
3. Hydration: client-side hydration strategy, streaming with Suspense
4. Caching: ISR (Incremental Static Regeneration), edge caching, stale-while-revalidate
5. SEO: meta tags, structured data, sitemap, robots.txt
6. Performance: streaming SSR, partial hydration, selective hydration (after: 'step-0')

2. [runner] Implement SSR:
1. Configure framework for SSR
2. Move data fetching to server side
3. Set up streaming/hydration
4. Configure caching strategy
5. Add SEO meta tags
6. Test with Lighthouse (after: 'step-1')

3. [reviewer] Verify: pages render server-side, hydration works, caching effective, SEO score improved, performance metrics acceptable. (after: 'step-2')

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
