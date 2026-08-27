# Mlops Reference Guide

## Overview
Set up ML operations: model training pipelines, experiment tracking, model registry, deployment, monitoring, and drift detection. Use when the goal is to operationalize ML models for production.

## # mlops

Set up ML operations: model training pipelines, experiment tracking, model registry, deployment, monitoring, and drift detection. Use when the goal is to operationalize ML models for production.

## Goal pattern

mlops machine learning operations model training deployment experiment tracking registry drift monitoring pipeline

## Steps

0. [context-gatherer] Map the ML landscape: what models are being trained? What framework (PyTorch, TensorFlow, scikit-learn)? What data sources? What compute resources (GPU, TPU, CPU)? What deployment target (API, edge, batch)?

1. [planner] Design the MLOps pipeline:
1. Experiment tracking: MLflow or Weights & Biases for logging params, metrics, artifacts
2. Model registry: version models, track lineage, promote to production
3. Training pipeline: data validation → preprocessing → training → evaluation → registration
4. Deployment: model serving (TF Serving, TorchServe, Triton) or serverless (Lambda, Cloud Functions)
5. Monitoring: prediction latency, error rates, data drift, concept drift
6. CI/CD: automated retraining on schedule or data change (after: 'step-0')

2. [runner] Implement the pipeline:
1. Set up experiment tracking (MLflow server or cloud)
2. Create training script with metric logging
3. Build data validation (Great Expectations or custom)
4. Create model serving endpoint
5. Add monitoring dashboard
6. Set up automated retraining trigger (after: 'step-1')

3. [reviewer] Verify the pipeline: train a model end-to-end, log to registry, deploy, serve predictions, check monitoring dashboards, trigger retraining. Verify the full loop works. (after: 'step-2')

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
