---
name: wsl-setup
description: Set up and configure Windows Subsystem for Linux (WSL): distribution selection, filesystem configuration, networking, GPU passthrough, and development environment setup. Use when setting up a Linux development environment on Windows.
version: 1.0.0
---

# wsl-setup

Set up and configure Windows Subsystem for Linux (WSL): distribution selection, filesystem configuration, networking, GPU passthrough, and development environment setup. Use when setting up a Linux development environment on Windows.

## Goal pattern

WSL windows subsystem linux setup configuration development environment GPU networking

## Steps

0. [context-gatherer] Map the WSL setup: what distribution (Ubuntu, Debian, Fedora)? What development tools needed? GPU support? Network configuration?

1. [planner] Design the WSL setup:
1. Distribution: choose and install WSL distro
2. Filesystem: /mnt/c for Windows files, ext4 for Linux
3. Networking: mirrored mode for port forwarding
4. GPU: WSL2 GPU passthrough for CUDA/ML
5. Dev tools: git, docker, node, python, vscode
6. Integration: VSCode Remote WSL, Windows Terminal profiles (after: 'step-0')

2. [runner] Set up WSL:
1. Enable WSL2 feature
2. Install chosen distribution
3. Configure networking mode
4. Set up GPU passthrough
5. Install development tools
6. Configure VSCode integration (after: 'step-1')

3. [reviewer] Verify: Linux commands work, filesystem accessible, networking works, GPU detected, dev tools functional. (after: 'step-2')
