# Game Asset Creation Guide

## Graphics

### Creating Sprites

#### Python + Pygame
```python
# Load sprite sheet
sprite_sheet = pygame.image.load("spritesheet.png")

# Extract individual sprites
def get_sprite(sheet, x, y, width, height):
    sprite = pygame.Surface((width, height))
    sprite.blit(sheet, (0, 0), (x, y, width, height))
    return sprite

# Example: 4 frames of animation
frames = [get_sprite(sprite_sheet, i * 32, 0, 32, 32) for i in range(4)]
```

#### JavaScript + Canvas
```javascript
// Load sprite sheet
const spriteSheet = new Image();
spriteSheet.src = "spritesheet.png";

// Extract sprites
function getSprite(sheet, x, y, width, height) {
    const sprite = document.createElement("canvas");
    sprite.width = width;
    sprite.height = height;
    const ctx = sprite.getContext("2d");
    ctx.drawImage(sheet, x, y, width, height, 0, 0, width, height);
    return sprite;
}

// Animation frames
const frames = [];
for (let i = 0; i < 4; i++) {
    frames.push(getSprite(spriteSheet, i * 32, 0, 32, 32));
}
```

### Creating Tile Maps

#### Simple Grid Tile Map
```python
# 10x10 board for snake-and-ladder
TILE_SIZE = 60
BOARD_SIZE = 10

def draw_tile_map(canvas, tiles):
    for row in range(BOARD_SIZE):
        for col in range(BOARD_SIZE):
            x = col * TILE_SIZE
            y = row * TILE_SIZE
            
            # Get tile type
            tile_type = tiles[row][col]
            
            # Draw tile
            if tile_type == "empty":
                canvas.create_rectangle(x, y, x + TILE_SIZE, y + TILE_SIZE, 
                                       fill="white", outline="black")
            elif tile_type == "snake":
                canvas.create_rectangle(x, y, x + TILE_SIZE, y + TILE_SIZE,
                                       fill="red", outline="black")
            elif tile_type == "ladder":
                canvas.create_rectangle(x, y, x + TILE_SIZE, y + TILE_SIZE,
                                       fill="green", outline="black")
            
            # Draw tile number
            tile_num = row * BOARD_SIZE + col + 1
            canvas.create_text(x + TILE_SIZE//2, y + TILE_SIZE//2,
                             text=str(tile_num))
```

### Creating Dice

#### Animated Dice Roll
```python
import random
import tkinter as tk

class Dice:
    def __init__(self, canvas, x, y, size=60):
        self.canvas = canvas
        self.x = x
        self.y = y
        self.size = size
        self.value = 1
        self.dots = {
            1: [(0.5, 0.5)],
            2: [(0.25, 0.25), (0.75, 0.75)],
            3: [(0.25, 0.25), (0.5, 0.5), (0.75, 0.75)],
            4: [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)],
            5: [(0.25, 0.25), (0.75, 0.25), (0.5, 0.5), (0.25, 0.75), (0.75, 0.75)],
            6: [(0.25, 0.25), (0.75, 0.25), (0.25, 0.5), (0.75, 0.5), (0.25, 0.75), (0.75, 0.75)],
        }
    
    def draw(self):
        # Draw dice face
        self.canvas.create_rectangle(self.x, self.y, 
                                    self.x + self.size, self.y + self.size,
                                    fill="white", outline="black", width=2)
        
        # Draw dots
        for dot_x, dot_y in self.dots[self.value]:
            cx = self.x + dot_x * self.size
            cy = self.y + dot_y * self.size
            r = self.size * 0.08
            self.canvas.create_oval(cx - r, cy - r, cx + r, cy + r,
                                   fill="black", outline="black")
    
    def roll(self, callback=None):
        """Animate dice roll and call callback with result."""
        def animate(frame):
            if frame < 10:
                self.value = random.randint(1, 6)
                self.canvas.delete("dice")
                self.draw()
                self.canvas.after(50, animate, frame + 1)
            else:
                # Final value
                self.value = random.randint(1, 6)
                self.canvas.delete("dice")
                self.draw()
                if callback:
                    callback(self.value)
        animate(0)
```

---

## Sound

### Python + Pygame
```python
import pygame

# Initialize mixer
pygame.mixer.init()

# Load sounds
dice_roll = pygame.mixer.Sound("sounds/dice_roll.wav")
win = pygame.mixer.Sound("sounds/win.wav")

# Play sound
dice_roll.play()

# Play with volume
win.set_volume(0.5)
win.play()

# Play background music
pygame.mixer.music.load("sounds/background.mp3")
pygame.mixer.music.play(-1)  # -1 = loop forever
```

### JavaScript + Web Audio API
```javascript
// Load sounds
const diceRoll = new Audio("sounds/dice_roll.wav");
const win = new Audio("sounds/win.wav");

// Play sound
diceRoll.play();

// Set volume
win.volume = 0.5;
win.play();

// Loop background music
const bgMusic = new Audio("sounds/background.mp3");
bgMusic.loop = true;
bgMusic.play();
```

---

## Fonts

### Python + Tkinter
```python
# Available fonts
import tkinter.font as tkfont

# List all fonts
fonts = tkfont.families()
print(fonts)

# Use a font
canvas.create_text(x, y, text="Hello", 
                  font=("Arial", 12, "bold"))
```

### JavaScript + Canvas
```javascript
// Use a font
ctx.font = "bold 24px Arial";
ctx.fillText("Hello", x, y);

// Load custom font
const font = new FontFace("GameFont", "url(fonts/game.woff2)");
font.load().then((loadedFont) => {
    document.fonts.add(loadedFont);
    ctx.font = "24px GameFont";
});
```

---

## Color Schemes

### Board Game Colors
```python
# Snake and Ladder color scheme
COLORS = {
    "background": "#FFFFFF",  # White
    "tile": "#F0F0F0",        # Light gray
    "snake": "#FF0000",       # Red
    "ladder": "#00FF00",      # Green
    "player1": "#0000FF",     # Blue
    "player2": "#FF00FF",     # Magenta
    "text": "#000000",        # Black
    "highlight": "#FFFF00",   # Yellow
}
```

### 2D Game Colors
```python
# Platformer color scheme
COLORS = {
    "sky": "#87CEEB",         # Sky blue
    "ground": "#8B4513",      # Saddle brown
    "player": "#FF6347",      # Tomato
    "enemy": "#DC143C",       # Crimson
    "coin": "#FFD700",        # Gold
    "platform": "#228B22",    # Forest green
}
```

---

## Animation Techniques

### Simple Animation (Frame-Based)
```python
class Animation:
    def __init__(self, frames, frame_rate=10):
        self.frames = frames
        self.frame_rate = frame_rate
        self.current_frame = 0
        self.timer = 0
    
    def update(self, dt):
        self.timer += dt
        if self.timer >= 1000 / self.frame_rate:
            self.timer = 0
            self.current_frame = (self.current_frame + 1) % len(self.frames)
    
    def get_current_frame(self):
        return self.frames[self.current_frame]
```

### Tweening (Smooth Movement)
```python
class Tween:
    def __init__(self, start, end, duration):
        self.start = start
        self.end = end
        self.duration = duration
        self.elapsed = 0
    
    def update(self, dt):
        self.elapsed += dt
        progress = min(self.elapsed / self.duration, 1.0)
        return self.start + (self.end - self.start) * progress
    
    def is_complete(self):
        return self.elapsed >= self.duration
```

### Particle System
```python
import random

class Particle:
    def __init__(self, x, y):
        self.x = x
        self.y = y
        self.vx = random.uniform(-2, 2)
        self.vy = random.uniform(-5, -1)
        self.life = 1.0
        self.decay = random.uniform(0.02, 0.05)
    
    def update(self):
        self.x += self.vx
        self.y += self.vy
        self.vy += 0.1  # Gravity
        self.life -= self.decay
    
    def is_alive(self):
        return self.life > 0

class ParticleSystem:
    def __init__(self):
        self.particles = []
    
    def emit(self, x, y, count=10):
        for _ in range(count):
            self.particles.append(Particle(x, y))
    
    def update(self):
        for p in self.particles:
            p.update()
        self.particles = [p for p in self.particles if p.is_alive()]
    
    def draw(self, canvas):
        for p in self.particles:
            alpha = int(p.life * 255)
            canvas.create_oval(p.x - 2, p.y - 2, p.x + 2, p.y + 2,
                             fill=f"#{alpha:02x}FF00")
```

---

## Best Practices

### Performance
1. **Use sprite sheets** instead of individual images
2. **Cache frequently used objects** (fonts, colors, sounds)
3. **Limit particle count** (max 100 particles)
4. **Use dirty rectangle rendering** (only redraw changed areas)
5. **Profile your game** to find bottlenecks

### Memory Management
1. **Unload assets** when not needed
2. **Reuse objects** instead of creating new ones
3. **Limit image sizes** (power of 2 for GPU efficiency)
4. **Compress textures** (use JPEG for photos, PNG for graphics)

### Code Organization
1. **Separate game logic from rendering**
2. **Use entity-component system** for complex games
3. **Create a resource manager** for loading/unloading assets
4. **Implement save/load functionality** early
