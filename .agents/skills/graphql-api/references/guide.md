# Graphql Api Reference Guide

## Overview
Design and implement GraphQL APIs: schema definition, resolvers, subscriptions, N+1 prevention, and query complexity limiting. Use when the goal asks to build a GraphQL API or migrate from REST to GraphQL.

## # graphql-api

Design and implement GraphQL APIs: schema definition, resolvers, subscriptions, N+1 prevention, and query complexity limiting. Use when the goal asks to build a GraphQL API or migrate from REST to GraphQL.

## Goal pattern

graphql schema resolver subscription apollo yoga n+1 dataloader codegen

## Parameters

- runtime (choice [default: auto]): GraphQL runtime

## Steps

1. [analyst] Design the GraphQL schema: define types, queries, mutations, and subscriptions using SDL. Include input types, enums, and union types.

2. [analyst] Implement resolvers: map each field to a data source. Use DataLoader for N+1 prevention on nested queries. Handle errors with GraphQL error extensions. (after: step-1)

3. [analyst] Add query complexity and depth limiting: prevent abuse by limiting query depth, field count, and computed complexity scores. (after: step-2)

4. [analyst] Set up subscriptions (WebSocket or SSE): implement real-time updates for mutations that should push to clients. (after: step-3)

5. [analyst] Generate TypeScript types from the schema (GraphQL Codegen), write integration tests, and document the API with example queries. (after: step-4)

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
