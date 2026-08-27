# Data Processing Reference Guide

## Overview
Process and transform data using Pandas, NumPy, or Polars. Use when the goal asks to clean, transform, aggregate, or analyze datasets.

## # data-processing

Process and transform data using Pandas, NumPy, or Polars. Use when the goal asks to clean, transform, aggregate, or analyze datasets.

## Goal pattern

data process transform clean aggregate analyze pandas numpy

## Parameters

- library (choice [default: pandas]): Data processing library

## Steps

1. [analyst] Load data from source (CSV, JSON, database). Inspect schema, missing values, and data types.

2. [analyst] Clean data: handle missing values, remove duplicates, fix data types, normalize formats. (after: step-0)

3. [analyst] Transform data: filter rows, add computed columns, merge datasets, pivot/aggregate. (after: step-1)

4. [analyst] Output results: save to file, generate reports, create visualizations. (after: step-2)

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
