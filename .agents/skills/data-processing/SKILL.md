---
name: data-processing
description: Process and transform data using Pandas, NumPy, or Polars. Use when the goal asks to clean, transform, aggregate, or analyze datasets.
version: 1.0.0
---

# data-processing

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
