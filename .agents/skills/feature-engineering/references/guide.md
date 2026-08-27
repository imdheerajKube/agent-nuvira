# Feature Engineering Reference Guide

## Overview
Engineer features for ML: encoding, scaling, selection, transformation, and feature stores. Use when preparing data for machine learning models.

## # feature-engineering

Engineer features for ML: encoding, scaling, selection, transformation, and feature stores. Use when preparing data for machine learning models.

## Goal pattern

feature engineering encoding scaling selection transformation PCA feature store preprocessing

## Steps

0. [context-gatherer] Map the data: what features exist? What types (numeric, categorical, text, date)? What missing values? What distributions? What target variable?

1. [planner] Plan feature engineering:
1. Numerical: scaling (StandardScaler, MinMaxScaler), log transforms, polynomial features
2. Categorical: one-hot encoding, target encoding, frequency encoding
3. Text: TF-IDF, word embeddings, topic features
4. Date: day of week, month, quarter, is_weekend, time since event
5. Selection: correlation analysis, mutual information, recursive feature elimination
6. Pipeline: sklearn Pipeline for reproducible transformations (after: 'step-0')

2. [runner] Implement feature engineering:
1. Analyze feature distributions and missing values
2. Create numerical transformations
3. Encode categorical variables
4. Extract text features
5. Generate date-based features
6. Select top features by importance (after: 'step-1')

3. [reviewer] Verify: check feature distributions, verify no data leakage, test pipeline end-to-end, measure impact on model performance. (after: 'step-2')

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
