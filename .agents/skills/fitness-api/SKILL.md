---
name: fitness-api
description: Build a fitness API: workout tracking, exercise database, nutrition logging, and progress analytics. Use when creating a fitness or wellness application backend.
version: 1.0.0
---

# fitness-api

Build a fitness API: workout tracking, exercise database, nutrition logging, and progress analytics. Use when creating a fitness or wellness application backend.

## Goal pattern

fitness API workout tracking exercise database nutrition logging progress analytics

## Parameters

(none)

## Steps

1. [context-gatherer] Map the API: what endpoints needed (workouts, exercises, meals, progress)? What database? What authentication? What analytics (charts, trends, goals)?

2. [planner] Design the fitness API:
1. Data model: exercises, workouts, meals, goals, progress
2. Endpoints: CRUD for all entities, analytics queries
3. Exercise database: pre-loaded exercises with muscle groups, equipment
4. Nutrition: food database, calorie/macro tracking
5. Progress: body measurements, workout PRs, trends
6. Auth: JWT with refresh tokens (after: step-0)

3. [runner] Implement the API:
1. Design database schema
2. Create API endpoints with validation
3. Build exercise database
4. Implement nutrition tracking
5. Add analytics queries
6. Seed with sample data (after: step-1)

4. [reviewer] Verify: CRUD operations, exercise search, nutrition logging, progress analytics, authentication flow. (after: step-2)
