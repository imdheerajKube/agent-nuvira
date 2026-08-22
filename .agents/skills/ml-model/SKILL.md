---
name: ml-model
description: Build and train ML models using scikit-learn, TensorFlow, or PyTorch. Use when the goal asks to train, evaluate, or deploy machine learning models.
version: 1.0.0
---

# ml-model

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
