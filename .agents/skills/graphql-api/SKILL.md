---
name: graphql-api
description: Design and implement GraphQL APIs: schema definition, resolvers, subscriptions, N+1 prevention, and query complexity limiting. Use when the goal asks to build a GraphQL API or migrate from REST to GraphQL.
version: 1.0.0
---

# graphql-api

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
