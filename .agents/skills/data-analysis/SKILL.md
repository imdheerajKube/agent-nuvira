---
name: data-analysis
description: Analyze datasets, identify trends, generate insights, and produce visualizations (charts, summaries, dashboards). Use when the goal asks to explore, analyze, summarize, or visualize data from CSV, JSON, databases, or APIs.
version: 1.0.0
---

# data-analysis

Analyze datasets, identify trends, generate insights, and produce visualizations (charts, summaries, dashboards). Use when the goal asks to explore, analyze, summarize, or visualize data from CSV, JSON, databases, or APIs.

## Goal pattern

data analysis csv json dataset trends visualization chart summary explore data analysis dashboard insights

## Parameters

- format (choice [default: html]): Output format

## Steps

1. [analyst] Profile the data: load the dataset, check shape (rows/columns), dtypes, missing values, and basic statistics (mean, median, std, min, max).

2. [analyst] Clean the data: handle missing values (drop/fill/interpolate), remove duplicates, normalize types, and flag outliers. (after: step-1)

3. [analyst] Explore patterns: compute correlations, group-by aggregations, time-series decompositions, or distribution shapes as appropriate for the data type. (after: step-2)

4. [analyst] Generate visualizations: produce the most informative charts (bar, line, scatter, heatmap, box-plot). Save as PNG/SVG or embed in an HTML dashboard. (after: step-3)

5. [analyst] Write a summary report: top-5 insights with evidence (charts + stats), data quality notes, and recommended next steps. (after: step-4)
