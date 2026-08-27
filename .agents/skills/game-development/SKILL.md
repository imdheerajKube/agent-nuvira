---
name: game-development
description: Create a GUI game with graphics, input handling, game logic, and packaging. Use when the goal asks to create, build, or develop a game (board games, card games, puzzle games, 2D games, snake-and-ladder, tic-tac-toe, chess, etc.).
version: 2.0.0
---

# game-development

Create a GUI game with graphics, input handling, game logic, and packaging. Use when the goal asks to create, build, or develop a game (board games, card games, puzzle games, 2D games, snake-and-ladder, tic-tac-toe, chess, etc.).

## Goal pattern

game create build develop snake ladder tic tac toe chess board card puzzle 2d platformer GUI play win lose

## Parameters

- gameType (choice [default: auto]): Type of game to create
- platform (choice [default: auto]): Target platform
- language (choice [default: auto]): Programming language (auto-detected from project if not specified)

## Steps

1. [context-gatherer] ## Step 1: Gather User Preferences

Before writing any code, ask the user for:
- **Game type**: board, card, puzzle, 2D, arcade?
- **Target platform**: Windows GUI, web browser, cross-platform?
- **Language preference**: Python, JavaScript, C#, C++?
- **Deliverable**: executable (.exe), web app, installable package?
- **Features**: multiplayer, AI opponent, animations, sound?

Use sensible defaults if the user doesn't care, but always ask before generating the code.

## Step 2: Detect Project State

Check the working directory:
```bash
ls -la
cat package.json 2>/dev/null || cat pyproject.toml 2>/dev/null || echo "No project config found"
```

If greenfield (empty directory):
- Create project structure
- Initialize package manager
- Set up build tools

If existing project:
- Use the same language/framework
- Follow existing code style
- Integrate with existing build system

## Step 3: Produce Game Design Brief

Create a brief with:
- Game type and mechanics
- Platform and language
- Core features (list)
- Deliverable format
- Estimated complexity (simple/moderate/complex)

2. [writer] ## Step 4: Implement Core Game Engine

Create the game logic as a single module/class:

### 4.1 Game State Management
```python
class GameState:
    def __init__(self):
        self.players = []
        self.current_turn = 0
        self.scores = {}
        self.is_game_over = False
        self.winner = None
```

### 4.2 Core Mechanics
- Dice roll: `random.randint(1, 6)`
- Card draw: `random.shuffle(deck)` + `deck.pop()`
- Piece movement: `position += dice_value`
- Collision detection: `if piece1.position == piece2.position`

### 4.3 Rules Engine
```python
def is_valid_move(self, player, move):
    # Check if move is legal
    return move in self.get_legal_moves(player)

def apply_move(self, player, move):
    # Apply the move and update state
    self.board[move] = player
    self.check_win_condition(player)
```

### 4.4 Win Condition
```python
def check_win_condition(self, player):
    # Check rows, columns, diagonals
    if self.check_row_win(player):
        self.is_game_over = True
        self.winner = player
```

Write as a single module that can be tested independently of the UI. (after: step-0)

3. [writer] ## Step 5: Implement GUI/Rendering Layer

### 5.1 Window Setup

**Python+tkinter:**
```python
import tkinter as tk

root = tk.Tk()
root.title("Snake and Ladder")
root.geometry("800x600")
canvas = tk.Canvas(root, width=800, height=600)
canvas.pack()
```

**Python+pygame:**
```python
import pygame

pygame.init()
screen = pygame.display.set_mode((800, 600))
pygame.display.set_caption("Snake and Ladder")
```

**JavaScript+Canvas:**
```javascript
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
canvas.width = 800;
canvas.height = 600;
```

**C#+WinForms:**
```csharp
var form = new Form()
{
    Text = "Snake and Ladder",
    Size = new Size(800, 600)
};
var canvas = new PictureBox()
{
    Dock = DockStyle.Fill,
    Image = new Bitmap(800, 600)
};
form.Controls.Add(canvas);
```

### 5.2 Game Board Rendering

Draw the board grid:
```python
# Python+tkinter example
def draw_board(canvas):
    cell_size = 60
    for row in range(10):
        for col in range(10):
            x1 = col * cell_size
            y1 = row * cell_size
            x2 = x1 + cell_size
            y2 = y1 + cell_size
            canvas.create_rectangle(x1, y1, x2, y2, fill="white", outline="black")
            # Draw cell number
            cell_num = row * 10 + col + 1
            canvas.create_text(x1 + 30, y1 + 30, text=str(cell_num))
```

### 5.3 Input Handling

**Mouse clicks:**
```python
canvas.bind("<Button-1>", on_click)
def on_click(event):
    # Handle click at (event.x, event.y)
    pass
```

**Keyboard:**
```python
root.bind("<Key>", on_key)
def on_key(event):
    if event.keysym == "space":
        roll_dice()
```

### 5.4 UI Elements

Add buttons, labels, and status displays:
```python
# Roll dice button
roll_btn = tk.Button(root, text="Roll Dice", command=roll_dice)
roll_btn.pack()

# Score display
score_label = tk.Label(root, text="Score: 0")
score_label.pack()

# Status message
status_label = tk.Label(root, text="Player 1's turn")
status_label.pack()
```

### 5.5 Animations

Add simple animations for dice roll and piece movement:
```python
def animate_dice_roll(canvas, callback):
    for i in range(10):
        # Show random face
        face = random.randint(1, 6)
        draw_dice(canvas, face)
        canvas.update()
        canvas.after(50)
    # Final result
    final = random.randint(1, 6)
    draw_dice(canvas, final)
    callback(final)
```

Connect the GUI to the game engine from Step 4. (after: step-1)

4. [runner] ## Step 6: Test the Game

### 6.1 Run the Game

**Python:**
```bash
python game.py
```

**JavaScript:**
```bash
open index.html  # macOS
xdg-open index.html  # Linux
start index.html  # Windows
```

**C#:**
```bash
dotnet run
```

### 6.2 Test Win/Lose Conditions

- Play through a complete game
- Verify winner is correctly detected
- Test with multiple players

### 6.3 Test Edge Cases

- Invalid moves (out of turn, illegal position)
- Restart game
- Draw conditions (if applicable)
- Window resize

### 6.4 Test Packaging

**Python+PyInstaller:**
```bash
pip install pyinstaller
pyinstaller --onefile game.py
ls -la dist/game  # Verify executable exists
```

**Python+cx_Freeze:**
```bash
pip install cx_Freeze
python setup.py build
```

**C#:**
```bash
dotnet publish -c Release -r win-x64 --self-contained
ls -la bin/Release/net8.0/win-x64/publish/  # Verify executable
```

**Electron (JavaScript):**
```bash
npm install electron --save-dev
npx electron-builder --win
```

### 6.5 Verify Deliverable

- Run the executable on a clean machine (or VM)
- Verify it launches without errors
- Verify all features work
- Check file size (aim for < 50MB) (after: step-2)

5. [reviewer] ## Step 7: Final Review

### 7.1 Code Quality

- Game logic is separated from UI
- Code is well-commented
- No hardcoded values (use constants)
- Error handling is present

### 7.2 Game Play

- Game is fun and engaging
- Rules are clear
- Controls are intuitive
- Visual feedback is present

### 7.3 Documentation

- README.md with:
  - Game description
  - How to play
  - How to build
  - Controls

### 7.4 Deliverable

- Executable works on target platform
- File size is reasonable
- No missing dependencies (after: step-3)
