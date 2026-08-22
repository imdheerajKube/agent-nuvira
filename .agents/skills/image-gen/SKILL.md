---
name: image-gen
description: Generate images using AI APIs (OpenAI DALL-E, Stability AI, etc.)
runtime: python
required_environment_variables:
  - OPENAI_API_KEY
tags:
  - creative
  - image
  - ai
parameters:
  - name: prompt
    description: Text description of the image to generate
    required: true
    type: string
  - name: size
    description: Image size (1024x1024, 512x512, 256x256)
    required: false
    type: string
    default: 1024x1024
  - name: output
    description: Output file path
    required: false
    type: string
    default: generated_image.png
---

# Image Generation Skill

Generate images using AI APIs. This skill demonstrates the execution engine's ability to run Python scripts with API key injection.

## How It Works

1. Receives a prompt and optional parameters
2. Calls the OpenAI DALL-E API to generate an image
3. Saves the result to a file
4. Returns the file path

## Usage

When the user asks to generate an image, execute this skill with the prompt as the argument.

## Security

- API keys are injected via environment variables (never hardcoded)
- Provider credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY) are blocked from passthrough for security
- This skill requires the user to set OPENAI_API_KEY in their environment
