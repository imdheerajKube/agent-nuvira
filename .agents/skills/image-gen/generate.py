#!/usr/bin/env python3
"""
Image Generation Skill — Demonstrates Python skill execution.

This script is executed by the skill-executor.ts module when the agent
calls: skill tool → execute: { skill: "image-gen", args: { prompt: "..." } }

The executor:
1. Detects runtime: python (from shebang or frontmatter)
2. Parses required_environment_variables: [OPENAI_API_KEY]
3. Injects OPENAI_API_KEY from process.env (if registered)
4. Spawns: python3 /tmp/skill-exec/abc123/generate.py
5. Captures stdout/stderr/exit code
"""

import json
import os
import sys
from pathlib import Path

def main():
    """Main entry point for image generation."""
    
    # Parse arguments
    prompt = None
    size = "1024x1024"
    output = "generated_image.png"
    
    # Simple argument parsing (supports --prompt, --size, --output)
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--prompt" and i + 1 < len(args):
            prompt = args[i + 1]
            i += 2
        elif args[i] == "--size" and i + 1 < len(args):
            size = args[i + 1]
            i += 2
        elif args[i] == "--output" and i + 1 < len(args):
            output = args[i + 1]
            i += 2
        else:
            # Treat as prompt if no --prompt flag
            if prompt is None:
                prompt = args[i]
            i += 1
    
    if not prompt:
        print("Error: --prompt is required", file=sys.stderr)
        print("Usage: python generate.py --prompt 'A sunset over mountains'", file=sys.stderr)
        sys.exit(1)
    
    # Check for API key
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable is not set", file=sys.stderr)
        print("Set it with: export OPENAI_API_KEY=sk-...", file=sys.stderr)
        sys.exit(1)
    
    # Simulate API call (in production, this would call OpenAI DALL-E)
    print(f"Generating image with prompt: {prompt}")
    print(f"Size: {size}")
    print(f"Output: {output}")
    
    # For demo purposes, create a placeholder file
    output_path = Path(output)
    output_path.write_text(f"[Placeholder for generated image]\nPrompt: {prompt}\nSize: {size}\n")
    
    print(f"\n✅ Image generated successfully!")
    print(f"📁 Saved to: {output_path.absolute()}")
    print(f"📊 File size: {output_path.stat().st_size} bytes")
    
    # Return structured result
    result = {
        "success": True,
        "output_file": str(output_path.absolute()),
        "prompt": prompt,
        "size": size
    }
    print(f"\n{json.dumps(result, indent=2)}")

if __name__ == "__main__":
    main()
