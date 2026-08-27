# Fine Tuning Reference Guide

## Overview
Fine-tune LLMs: data preparation, training config, training loop, evaluation, and deployment. Use when the goal is to customize a base model for a specific task or domain.

## # fine-tuning

Fine-tune LLMs: data preparation, training config, training loop, evaluation, and deployment. Use when the goal is to customize a base model for a specific task or domain.

## Goal pattern

fine-tuning fine-tune LLM model training dataset custom model domain adaptation LoRA QLoRA

## Steps

0. [context-gatherer] Map the requirements: what base model? What task (classification, generation, instruction-following)? How much training data? What compute budget? What evaluation metrics?

1. [planner] Design the fine-tuning approach:
1. Data prep: collect, clean, format (instruction/input/output triples)
2. Training method: full fine-tune vs LoRA vs QLoRA (based on compute budget)
3. Hyperparameters: learning rate, batch size, epochs, warmup, weight decay
4. Evaluation: hold-out set, task-specific metrics, human evaluation
5. Deployment: merge LoRA weights, export to serving format, deploy (after: 'step-0')

2. [runner] Execute the fine-tuning:
1. Prepare dataset in the required format (JSONL for most frameworks)
2. Configure training (Hugging Face Trainer, Axolotl, or OpenAI fine-tuning API)
3. Train with checkpointing and early stopping
4. Evaluate on held-out set
5. Export the best model
6. Deploy and test inference (after: 'step-1')

3. [reviewer] Evaluate the fine-tuned model: compare against baseline, measure improvement on target task, check for regressions on general capabilities, report resource usage. (after: 'step-2')

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
