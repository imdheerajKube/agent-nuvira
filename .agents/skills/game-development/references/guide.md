# Game Development Reference Guide

## Overview
Create a GUI game with graphics, input handling, game logic, and packaging. Use when the goal asks to create, build, or develop a game (board games, card games, puzzle games, 2D games, snake-and-ladder, tic-tac-toe, chess, etc.).

## # game-development

Create a GUI game with graphics, input handling, game logic, and packaging. Use when the goal asks to create, build, or develop a game (board games, card games, puzzle games, 2D games, snake-and-ladder, tic-tac-toe, chess, etc.).

## Goal pattern

game create build develop snake ladder tic tac toe chess board card puzzle 2d platformer GUI play win lose

## Parameters

- gameType (choice [default: auto]): Type of game to create — board, card, puzzle, 2d, arcade, auto
- platform (choice [default: auto]): Target platform — windows-gui, web, cross-platform, auto
- language (choice [default: auto]): Programming language — python, javascript, typescript, csharp, cpp, auto

## Steps

1. [context-gatherer] Analyze the game requirements:
   - What type of game? (board, card, puzzle, 2D, arcade)
   - What platform? (Windows GUI, web browser, cross-platform)
   - What language/framework? (Python+tkinter, Python+pygame, JavaScript+Canvas, C#+WinForms, C++ with SFML)
   - What are the core mechanics? (turn-based, real-time, physics, AI opponent)
   - What assets are needed? (images, sounds, fonts)
   - What is the deliverable? (executable, web app, installable package)
   Produce: a game design brief with type, platform, framework, mechanics, and deliverable format.

2. [writer] Implement the core game engine and logic:
   - Game state management (scores, turns, win conditions)
   - Core mechanics (dice roll, card draw, piece movement, collision)
   - Rules engine (enforce game rules, detect invalid moves)
   - AI opponent (if applicable: simple minimax, rule-based, or random)
   Write as a single module/class that can be tested independently of the UI.

3. [writer] Implement the GUI/rendering layer:
   - Window setup and canvas/drawing area
   - Game board rendering (grid, pieces, cards, dice)
   - Input handling (mouse clicks, keyboard, touch)
   - UI elements (buttons, score display, status messages, restart)
   - Animations (dice roll, piece movement, win celebration)
   Connect the GUI to the game engine from step-1.

4. [runner] Test and package the game:
   - Verify the game runs without errors
   - Test win/lose conditions
   - Test edge cases (invalid moves, restart, draw)
   - Package for distribution:
     - Python: `pip install pyinstaller && pyinstaller --onefile game.py`
     - JavaScript: create an HTML file or use Electron for desktop
     - C#: `dotnet publish -c Release -r win-x64 --self-contained`
     - Generic: create a README with build instructions
   Produce the deliverable (executable, web app, or build instructions).

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
