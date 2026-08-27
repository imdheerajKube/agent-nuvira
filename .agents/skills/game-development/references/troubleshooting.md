# Game Development Troubleshooting Guide

## Common Issues and Fixes

### 1. Window Not Responding

**Symptoms:**
- Game window freezes
- Cannot click buttons
- animations stop

**Causes:**
- Blocking main thread
- Infinite loop in game logic
- Long-running operation in event handler

**Fixes:**
```python
# Python + Tkinter
# BAD: Blocking main thread
def on_click():
    for i in range(1000000):
        pass  # Freezes window

# GOOD: Non-blocking
def on_click():
    root.after(0, do_work)

def do_work():
    # Do work in chunks
    for i in range(1000):
        pass
    if more_work:
        root.after(10, do_work)
```

```javascript
// JavaScript + Canvas
// BAD: Blocking main thread
function on_click() {
    for (let i = 0; i < 1000000; i++) {
        // Freezes browser
    }
}

// GOOD: Non-blocking with requestAnimationFrame
function on_click() {
    let i = 0;
    function work() {
        for (let j = 0; j < 1000; j++) {
            // Do work
        }
        i += 1000;
        if (i < 1000000) {
            requestAnimationFrame(work);
        }
    }
    work();
}
```

### 2. Canvas Not Updating

**Symptoms:**
- Drawings don't appear
- Screen stays black
- Animations don't show

**Causes:**
- Missing `update()` or `flip()` call
- Wrong canvas reference
- Drawing outside visible area

**Fixes:**
```python
# Python + Tkinter
# BAD: Missing update
def draw():
    canvas.create_rectangle(10, 10, 100, 100, fill="red")

# GOOD: Force update
def draw():
    canvas.create_rectangle(10, 10, 100, 100, fill="red")
    canvas.update()  # Force redraw
```

```python
# Python + Pygame
# BAD: Missing flip
def draw():
    pygame.draw.rect(screen, (255, 0, 0), (10, 10, 100, 100))

# GOOD: Flip display
def draw():
    screen.fill((0, 0, 0))  # Clear screen
    pygame.draw.rect(screen, (255, 0, 0), (10, 10, 100, 100))
    pygame.display.flip()  # Update display
```

### 3. Event Handling Not Working

**Symptoms:**
- Button clicks don't register
- Keyboard input ignored
- Mouse movements not tracked

**Causes:**
- Event handler not bound
- Wrong event type
- Event consumed by another widget

**Fixes:**
```python
# Python + Tkinter
# BAD: Wrong binding
root.bind("click", on_click)  # Wrong event name

# GOOD: Correct binding
canvas.bind("<Button-1>", on_click)  # Left mouse button
root.bind("<Key>", on_key)  # Any key
root.bind("<space>", on_space)  # Specific key
```

```javascript
// JavaScript + Canvas
// BAD: Missing event listener
canvas.onclick = on_click;  # Old syntax

// GOOD: Add event listener
canvas.addEventListener("click", on_click);
document.addEventListener("keydown", on_key);
```

### 4. Game Loop Too Fast/Slow

**Symptoms:**
- Game runs too fast
- Game runs too slow
- Inconsistent speed

**Causes:**
- No frame rate limiting
- Using `time.sleep()` instead of proper timing
- Not accounting for delta time

**Fixes:**
```python
# Python + Tkinter
# BAD: No frame rate control
def game_loop():
    update_game()
    draw_game()
    game_loop()  # Runs as fast as possible

# GOOD: Frame rate control
FPS = 60
FRAME_TIME = 1000 // FPS  # Milliseconds

def game_loop():
    start_time = time.time()
    
    update_game()
    draw_game()
    
    # Wait for next frame
    elapsed = (time.time() - start_time) * 1000
    delay = max(0, FRAME_TIME - elapsed)
    root.after(delay, game_loop)
```

```javascript
// JavaScript + Canvas
// BAD: Using setInterval
setInterval(gameLoop, 16);  // Inconsistent timing

// GOOD: Using requestAnimationFrame
let lastTime = 0;
function gameLoop(timestamp) {
    const deltaTime = timestamp - lastTime;
    lastTime = timestamp;
    
    updateGame(deltaTime);
    renderGame();
    
    requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
```

### 5. Memory Leaks

**Symptoms:**
- Game gets slower over time
- Memory usage increases
- Eventually crashes

**Causes:**
- Not removing event listeners
- Not clearing arrays/lists
- Not destroying unused objects

**Fixes:**
```python
# Python + Tkinter
# BAD: Not cleaning up
def create_particles():
    particles = []
    for i in range(100):
        particles.append(Particle())
    return particles

# GOOD: Clean up
def create_particles():
    particles = []
    for i in range(100):
        particles.append(Particle())
    return particles

def cleanup_particles(particles):
    particles.clear()  # Remove all particles
```

```javascript
// JavaScript + Canvas
// BAD: Not removing listeners
function setup() {
    canvas.addEventListener("click", handleClick);
}

// GOOD: Remove when done
function setup() {
    canvas.addEventListener("click", handleClick);
}

function cleanup() {
    canvas.removeEventListener("click", handleClick);
}
```

### 6. PyInstaller Issues

**Symptoms:**
- "No module named X" error
- Executable doesn't run
- Antivirus flags executable

**Fixes:**
```bash
# Missing module
pyinstaller --collect-all tkinter game.py
pyinstaller --hidden-import=pygame game.py

# Large file size
pyinstaller --strip --exclude-module=matplotlib game.py

# Antivirus false positive
# Sign the executable
signtool sign /f certificate.pfx /p password game.exe

# Or use --onefile with --windowed
pyinstaller --onefile --windowed game.py
```

### 7. Electron Build Issues

**Symptoms:**
- Build fails
- Black screen
- Slow startup

**Fixes:**
```javascript
// main.js
const { app, BrowserWindow } = require("electron");

function createWindow() {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,  // Allow Node.js
            contextIsolation: false  // Disable context isolation
        }
    });
    
    win.loadFile("index.html");
}

app.whenReady().then(createWindow);
```

```bash
# Build for Windows
npx electron-builder --win

# If build fails, try
npm install
npx electron-builder --win --config.win.sign=false
```

### 8. C# WinForms Issues

**Symptoms:**
- Flickering
- High DPI issues
- Missing resources

**Fixes:**
```csharp
// Flickering
public class GameForm : Form
{
    public GameForm()
    {
        // Enable double buffering
        this.SetStyle(
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint,
            true);
        this.UpdateStyles();
    }
}

// High DPI
// In app.manifest:
// <dpiAware>true</dpiAware>
```

---

## Debugging Tips

### Python
```python
# Print debug info
print(f"Player position: {player.position}")
print(f"Score: {score}")

# Use logging
import logging
logging.basicConfig(level=logging.DEBUG)
logging.debug(f"Game state: {game_state}")

# Use debugger
import pdb; pdb.set_trace()  # Python 3.7+
# Or: breakpoint()  # Python 3.7+
```

### JavaScript
```javascript
// Console logging
console.log("Player position:", player.position);
console.log("Score:", score);

// Debugger
debugger;  // Pauses execution

// Performance profiling
console.time("update");
updateGame();
console.timeEnd("update");
```

### C#
```csharp
// Debug output
Debug.WriteLine($"Player position: {player.Position}");
Debug.WriteLine($"Score: {score}");

// Breakpoint
System.Diagnostics.Debugger.Break();
```

---

## Performance Optimization

### 1. Reduce Draw Calls
```python
# BAD: Draw each tile separately
for tile in tiles:
    canvas.create_rectangle(tile.x, tile.y, ...)

# GOOD: Use batch drawing
canvas.create_rectangle(*bounding_box, fill="white")
# Then draw only visible tiles
```

### 2. Use Object Pooling
```python
# BAD: Create new objects frequently
def spawn_bullet():
    bullets.append(Bullet())

# GOOD: Reuse objects
bullet_pool = [Bullet() for _ in range(100)]

def spawn_bullet():
    for bullet in bullet_pool:
        if not bullet.active:
            bullet.activate()
            return
```

### 3. Optimize Collision Detection
```python
# BAD: Check all pairs
for a in objects:
    for b in objects:
        if a != b and check_collision(a, b):
            handle_collision(a, b)

# GOOD: Use spatial partitioning
grid = [[[] for _ in range(cols)] for _ in range(rows)]
for obj in objects:
    grid[obj.row][obj.col].append(obj)

# Only check nearby cells
for row in range(max(0, obj.row-1), min(rows, obj.row+2)):
    for col in range(max(0, obj.col-1), min(cols, obj.col+2)):
        for other in grid[row][col]:
            if obj != other and check_collision(obj, other):
                handle_collision(obj, other)
```

### 4. Cache Frequently Used Data
```python
# BAD: Recalculate every frame
def get_color(value):
    return f"#{int(value * 255):02x}0000"

# GOOD: Cache results
color_cache = {}
def get_color(value):
    if value not in color_cache:
        color_cache[value] = f"#{int(value * 255):02x}0000"
    return color_cache[value]
```

---

## Testing Checklist

### Functionality
- [ ] Game starts without errors
- [ ] All buttons work
- [ ] Keyboard input works
- [ ] Mouse input works
- [ ] Game rules are enforced
- [ ] Win/lose conditions work
- [ ] Score tracking works
- [ ] Restart works

### Performance
- [ ] 60 FPS on target hardware
- [ ] No memory leaks
- [ ] No lag spikes
- [ ] Smooth animations

### Packaging
- [ ] Executable runs on clean machine
- [ ] No missing dependencies
- [ ] Reasonable file size (< 50MB)
- [ ] No antivirus false positives

### Documentation
- [ ] README.md exists
- [ ] How to build is documented
- [ ] How to play is documented
- [ ] Controls are documented
