# Fitness Api Reference Guide

## Overview
Build a fitness API: workout tracking, exercise database, nutrition logging, and progress analytics. Use when creating a fitness or wellness application backend.

## # fitness-api

Build a fitness API: workout tracking, exercise database, nutrition logging, and progress analytics. Use when creating a fitness or wellness application backend.

## Goal pattern

fitness API workout tracking exercise database nutrition logging progress analytics

## Steps

0. [context-gatherer] Map the API: what endpoints needed (workouts, exercises, meals, progress)? What database? What authentication? What analytics (charts, trends, goals)?

1. [planner] Design the fitness API:
1. Data model: exercises, workouts, meals, goals, progress
2. Endpoints: CRUD for all entities, analytics queries
3. Exercise database: pre-loaded exercises with muscle groups, equipment
4. Nutrition: food database, calorie/macro tracking
5. Progress: body measurements, workout PRs, trends
6. Auth: JWT with refresh tokens (after: 'step-0')

2. [runner] Implement the API:
1. Design database schema
2. Create API endpoints with validation
3. Build exercise database
4. Implement nutrition tracking
5. Add analytics queries
6. Seed with sample data (after: 'step-1')

3. [reviewer] Verify: CRUD operations, exercise search, nutrition logging, progress analytics, authentication flow. (after: 'step-2')

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
