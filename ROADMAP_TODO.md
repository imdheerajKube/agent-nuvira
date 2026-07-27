# Agent-Nuvira Implementation TODOs

## Immediate Priorities

1. Harden provider plugin discovery
   - Verify `~/.buff/plugins/` auto-discovery works reliably.
   - Add `buff plugins list` and `buff provider health` commands.

2. Improve provider UX
   - Enhance `src/cli/model-picker.ts` to show plugin providers and type info.
   - Add `buff provider list` command and better error messages for provider failures.

3. Stabilize CLI flows
   - Polish `buff execute`, `buff chat`, `buff model switch`, and `buff doctor`.
   - Add `buff execute --dry-run` and `buff execute --review` support.

4. Add onboarding support
   - Implement a guided `buff init` flow that detects local models and configures providers.
   - Add clear docs in `README.md` and `Product_Guide.md` around provider setup.

## Next Milestone

5. Workflow templates
   - Build built-in workflow templates and support user-defined templates in `~/.buff/workflows/`.
   - Add CLI commands: `buff workflow list`, `buff workflow run <name>`.

6. Agent extensibility
   - Add plugin support for external agent roles and pipeline extensions.
   - Enable CLI discovery and registration for custom agent plugins.

7. Smarter routing and memory
   - Improve `src/learning/hybrid-router.ts` with provider benchmarking and user preferences.
   - Add `buff skill list`, `buff skill run`, and `buff skill create` commands.

## Longer-term Goals

8. Security and sandboxing
   - Expand `src/security/scanner.ts` into a security audit flow.
   - Harden sandbox execution in `src/sandbox/manager.ts` and add validation before applying changes.

9. Feedback and learning
   - Capture run outcomes in `src/learning/agent-stats.ts`.
   - Use feedback to improve provider selection and agent routing.

10. Ecosystem and docs
   - Publish plugin and workflow APIs.
   - Add a marketplace or registry for community plugins and templates.
