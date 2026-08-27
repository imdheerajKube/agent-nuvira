# Platform-Specific Game Development Guide

## Python + Tkinter (Windows GUI)

### Setup
```bash
# Tkinter is included with Python - no installation needed
python --version  # Verify Python 3.7+

# For packaging
pip install pyinstaller
```

### Window Creation
```python
import tkinter as tk
from tkinter import ttk

class GameWindow:
    def __init__(self, title="Game", width=800, height=600):
        self.root = tk.Tk()
        self.root.title(title)
        self.root.geometry(f"{width}x{height}")
        self.root.resizable(False, False)
        
        # Create canvas for game rendering
        self.canvas = tk.Canvas(self.root, width=width, height=height)
        self.canvas.pack()
        
    def run(self):
        self.root.mainloop()
```

### Drawing Shapes
```python
# Rectangle
canvas.create_rectangle(x1, y1, x2, y2, fill="blue", outline="black")

# Circle/Oval
canvas.create_oval(x1, y1, x2, y2, fill="red", outline="black")

# Line
canvas.create_line(x1, y1, x2, y2, fill="black", width=2)

# Text
canvas.create_text(x, y, text="Hello", font=("Arial", 12), fill="white")

# Image
photo = tk.PhotoImage(file="image.png")
canvas.create_image(x, y, image=photo)
```

### Event Handling
```python
# Mouse click
canvas.bind("<Button-1>", on_left_click)
canvas.bind("<Button-3>", on_right_click)  # Right click

# Mouse movement
canvas.bind("<B1-Motion>", on_drag)  # Drag with left button
canvas.bind("<Motion>", on_hover)  # Hover

# Keyboard
root.bind("<Key>", on_key)
root.bind("<space>", on_space)  # Specific key

# Game loop (16ms = ~60 FPS)
def game_loop():
    update_game()
    root.after(16, game_loop)
game_loop()
```

### Packaging with PyInstaller
```bash
# Basic packaging
pyinstaller --onefile game.py

# With icon
pyinstaller --onefile --icon=game.ico game.py

# Windowed (no console)
pyinstaller --onefile --windowed game.py

# With additional files
pyinstaller --onefile --add-data "assets/*:assets" game.py
```

---

## Python + PyCross (Cross-Platform)

### Setup
```bash
pip install pygame
```

### Window Creation
```python
import pygame

pygame.init()
screen = pygame.display.set_mode((800, 600))
pygame.display.set_caption("Game")

# Game loop
running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
    
    # Update game state
    update_game()
    
    # Render
    screen.fill((0, 0, 0))  # Clear screen
    draw_game(screen)
    pygame.display.flip()

pygame.quit()
```

### Drawing
```python
# Rectangle
pygame.draw.rect(screen, (255, 0, 0), (x, y, width, height))

# Circle
pygame.draw.circle(screen, (0, 255, 0), (x, y), radius)

# Line
pygame.draw.line(screen, (0, 0, 255), (x1, y1), (x2, y2), width)

# Text
font = pygame.font.Font(None, 36)
text = font.render("Hello", True, (255, 255, 255))
screen.blit(text, (x, y))

# Image
image = pygame.image.load("image.png")
screen.blit(image, (x, y))
```

---

## JavaScript + HTML5 Canvas (Web)

### Setup
```html
<!DOCTYPE html>
<html>
<head>
    <title>Game</title>
    <style>
        body { margin: 0; overflow: hidden; }
        canvas { display: block; }
    </style>
</head>
<body>
    <canvas id="gameCanvas"></canvas>
    <script src="game.js"></script>
</body>
</html>
```

### Canvas Setup
```javascript
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

canvas.width = 800;
canvas.height = 600;

// Game loop (requestAnimationFrame for smooth animation)
function gameLoop() {
    updateGame();
    renderGame();
    requestAnimationFrame(gameLoop);
}
gameLoop();
```

### Drawing
```javascript
// Rectangle
ctx.fillStyle = "blue";
ctx.fillRect(x, y, width, height);

// Circle
ctx.beginPath();
ctx.arc(x, y, radius, 0, Math.PI * 2);
ctx.fillStyle = "red";
ctx.fill();

// Line
ctx.beginPath();
ctx.moveTo(x1, y1);
ctx.lineTo(x2, y2);
ctx.strokeStyle = "black";
ctx.lineWidth = 2;
ctx.stroke();

// Text
ctx.font = "24px Arial";
ctx.fillStyle = "white";
ctx.fillText("Hello", x, y);

// Image
const img = new Image();
img.src = "image.png";
img.onload = () => {
    ctx.drawImage(img, x, y);
};
```

### Event Handling
```javascript
// Mouse click
canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    handleClick(x, y);
});

// Keyboard
document.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
        rollDice();
    }
});
```

---

## C# + WinForms (Windows)

### Setup
```bash
dotnet new winforms -n GameProject
cd GameProject
dotnet add package System.Drawing.Common
```

### Window Creation
```csharp
using System;
using System.Drawing;
using System.Windows.Forms;

public class GameForm : Form
{
    private Bitmap canvas;
    private Graphics g;
    
    public GameForm()
    {
        this.Text = "Game";
        this.Size = new Size(800, 600);
        this.StartPosition = FormStartPosition.CenterScreen;
        
        canvas = new Bitmap(800, 600);
        g = Graphics.FromImage(canvas);
        
        this.Paint += OnPaint;
        this.MouseClick += OnMouseClick;
        this.KeyDown += OnKeyDown;
        
        // Game loop
        Timer timer = new Timer();
        timer.Interval = 16; // ~60 FPS
        timer.Tick += (s, e) => { UpdateGame(); this.Invalidate(); };
        timer.Start();
    }
    
    private void OnPaint(object sender, PaintEventArgs e)
    {
        e.Graphics.DrawImage(canvas, 0, 0);
    }
}
```

### Drawing
```csharp
// Rectangle
g.DrawRectangle(Pens.Black, x, y, width, height);
g.FillRectangle(Brushes.Blue, x, y, width, height);

// Circle
g.DrawEllipse(Pens.Black, x, y, width, height);
g.FillEllipse(Brushes.Red, x, y, width, height);

// Line
g.DrawLine(Pens.Black, x1, y1, x2, y2);

// Text
g.DrawString("Hello", new Font("Arial", 12), Brushes.White, x, y);

// Image
Image img = Image.FromFile("image.png");
g.DrawImage(img, x, y);
```

---

## Packaging Guide

### Python → Windows .exe
```bash
# Install PyInstaller
pip install pyinstaller

# Create executable
pyinstaller --onefile --windowed game.py

# With icon
pyinstaller --onefile --windowed --icon=game.ico game.py

# Output: dist/game.exe
```

### JavaScript → Desktop (Electron)
```bash
# Initialize Electron project
npm init -y
npm install electron --save-dev

# Create main.js
# package.json: "main": "main.js"

# Build
npx electron-builder --win

# Output: dist/Game Setup.exe
```

### C# → Windows .exe
```bash
# Publish as self-contained
dotnet publish -c Release -r win-x64 --self-contained

# Output: bin/Release/net8.0/win-x64/publish/Game.exe
```

---

## Troubleshooting

### Python Tkinter Issues
- **"No module named tkinter"**: Install python3-tk package
  - Ubuntu: `sudo apt install python3-tk`
  - macOS: `brew install python-tk`
- **Window not responding**: Ensure `root.mainloop()` is called
- **Canvas not updating**: Call `canvas.update()` or `root.update()`

### PyInstaller Issues
- **Missing DLLs**: Add `--collect-all tkinter` flag
- **Large file size**: Use `--strip` flag, exclude unnecessary modules
- **Antivirus false positive**: Sign the executable with a certificate

### Electron Issues
- **Black screen**: Check for missing `nodeIntegration: true`
- **Slow startup**: Use `--no-sandbox` flag for testing
- **Build fails**: Ensure `main.js` path is correct in package.json

### C# WinForms Issues
- **"System.Drawing.Common" not found**: Add NuGet package
- **Flickering**: Use double buffering (`SetStyle(ControlStyles.OptimizedDoubleBuffer, true)`)
- **High DPI issues**: Add `<dpiAware>true</dpiAware>` to app.manifest
