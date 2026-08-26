---
name: data-visualization
description: Create data visualizations: charts, dashboards, interactive plots with D3.js, Plotly, Matplotlib, or Chart.js. Covers data transformation, chart selection, accessibility, and export. Use when the goal is to visualize data.
version: 1.0.0
---

# data-visualization

Create data visualizations: charts, dashboards, interactive plots with D3.js, Plotly, Matplotlib, or Chart.js. Covers data transformation, chart selection, accessibility, and export. Use when the goal is to visualize data.

## Goal pattern

data visualization chart dashboard plot D3 plotly matplotlib chart.js graph infographic

## Steps

0. [context-gatherer] Map the data: what data format (CSV, JSON, database)? What story to tell? What chart type (bar, line, scatter, heatmap, treemap)? What platform (web, print, notebook)? Interactivity needed?

1. [planner] Design the visualization:
1. Choose chart type based on data and message
2. Select library (D3 for custom, Plotly for interactive, Chart.js for simple, Matplotlib for notebooks)
3. Design color scheme (accessible, colorblind-friendly)
4. Add labels, legends, annotations
5. Plan interactivity (tooltips, zoom, filter)
6. Export format (SVG, PNG, HTML) (after: 'step-0')

2. [runner] Create the visualization:
1. Load and transform data
2. Create the chart with chosen library
3. Style with colors, fonts, labels
4. Add interactivity if needed
5. Export to target format
6. Test on different screen sizes (after: 'step-1')

3. [reviewer] Review: verify data accuracy, check accessibility (alt text, color contrast), test interactivity, confirm export quality. (after: 'step-2')
