# Env Setup Reference Guide

## Overview
Set up a development environment: detect the stack, install dependencies, configure services, verify everything works, and document the setup. Use when the goal asks to set up the environment, configure dev tools, bootstrap a project, or get the project running locally.

## # env-setup

Set up a development environment: detect the stack, install dependencies, configure services, verify everything works, and document the setup. Use when the goal asks to set up the environment, configure dev tools, bootstrap a project, or get the project running locally.

## Goal pattern

environment setup configure dev install dependencies bootstrap local development get running

## Parameters

- stack (choice [default: auto]): Technology stack (auto-detected from project if not specified)

## Steps

1. [context-gatherer] Detect the project stack:
- Read package.json / pyproject.toml / go.mod / Cargo.toml for: language, framework, scripts, dependencies
- Read README.md for setup instructions (often has the exact steps)
- Check for .env.example / .env.template for required environment variables
- Check for docker-compose.yml / Makefile for setup commands
- Note required system tools (Node, Python, Go, Docker, PostgreSQL, Redis, etc.)
Produce: the stack, the required tools, and the setup sequence.

2. [runner] Install dependencies in order:
- System deps: install missing runtimes/tools (nvm, pyenv, go install, brew/apt)
- Project deps: Run `npm install` / `pip install -e .` / `go mod download` / `cargo build`
- Dev tools: linter, formatter, type checker (often in devDependencies)
- Verify each install succeeded (check exit codes, no errors in output)
Install system deps first, then project deps, then dev tools — in that order. (after: step-0)

3. [runner] Configure the environment:
- Copy .env.example to .env (or create .env from the template)
- Set required env vars (database URL, API keys for dev services, ports)
- Start required services (database, cache, queue) — via docker-compose or local install
- Run database migrations if applicable: Run `npx prisma migrate dev` / `alembic upgrade head`
The environment must be in a working state before verification. (after: step-1)

4. [tester] Verify the setup works:
- Run the dev server: Run `npm run dev` / `python manage.py runserver` / etc.
- Verify it starts without errors (check the output for crash/error)
- Run the test suite: Run `npm test` or equivalent
- Run the build: Run `npm run build` or equivalent
If anything fails: diagnose the issue (missing dep, wrong env var, port conflict) and fix it. (after: step-2)

5. [writer] Document the setup:
- Update README.md with: prerequisites, install steps, env var setup, how to run dev/test/build
- Add a TROUBLESHOOTING section for common issues (port conflicts, missing env vars, DB connection)
- Note any platform-specific steps (macOS vs Linux vs Windows)
Future contributors should be able to set up from the README alone. (after: step-3)

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
