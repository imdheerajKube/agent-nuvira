# Ml Model Reference Guide

## Overview
Build and train ML models using scikit-learn, TensorFlow, or PyTorch. Use when the goal asks to train, evaluate, or deploy machine learning models.

## # ml-model

Build and train ML models using scikit-learn, TensorFlow, or PyTorch. Use when the goal asks to train, evaluate, or deploy machine learning models.

## Goal pattern

machine learning model train predict classify regress ml ai

## Parameters

- framework (choice [default: scikit-learn]): ML framework

## Steps

1. [analyst] Load and explore dataset. Perform feature engineering and selection.

2. [analyst] Split data into train/test sets. Choose model architecture and hyperparameters. (after: step-0)

3. [analyst] Train model with cross-validation. Evaluate metrics (accuracy, precision, recall, F1). (after: step-1)

4. [analyst] Save model, create inference pipeline, document results. (after: step-2)

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
