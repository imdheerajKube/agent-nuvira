"""
Generate a professional 128x128 PNG icon for the Agent-Baba-D VS Code extension.

The icon features:
- Rounded square with gradient background (deep purple → vibrant blue)
- Stylized overlapping "A" letter mark representing "Agent" and "AI"
- Subtle grid/tech texture
- Glow effect around the letter

Uses only built-in Python modules (struct, zlib).
"""

import struct
import zlib


def create_png(width, height, pixels):
    """
    Create a PNG from raw RGBA pixel data.
    pixels is a list of lists: pixels[y][x] = (r, g, b, a)
    """
    # Convert pixel data to raw bytes
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter byte (None)
        for x in range(width):
            r, g, b, a = pixels[y][x]
            raw_data += struct.pack('BBBB', r, g, b, a)

    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw_data))
    png += chunk(b'IEND', b'')
    return png


def lerp(a, b, t):
    """Linearly interpolate between a and b."""
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    """Linearly interpolate between two RGB colors."""
    return (
        int(lerp(c1[0], c2[0], t)),
        int(lerp(c1[1], c2[1], t)),
        int(lerp(c1[2], c2[2], t)),
    )


def is_inside_rounded_rect(x, y, cx, cy, w, h, r):
    """Check if (x, y) is inside a rounded rectangle centered at (cx, cy)."""
    # Translate to top-left corner of the rect
    rx = x - (cx - w / 2)
    ry = y - (cy - h / 2)

    if rx < 0 or rx > w or ry < 0 or ry > h:
        return False

    # Check corners
    if rx < r and ry < r:
        return (rx - r) ** 2 + (ry - r) ** 2 <= r ** 2
    if rx > w - r and ry < r:
        return (rx - (w - r)) ** 2 + (ry - r) ** 2 <= r ** 2
    if rx < r and ry > h - r:
        return (rx - r) ** 2 + (ry - (h - r)) ** 2 <= r ** 2
    if rx > w - r and ry > h - r:
        return (rx - (w - r)) ** 2 + (ry - (h - r)) ** 2 <= r ** 2

    return True


def smoothstep(edge0, edge1, x):
    """Smooth Hermite interpolation."""
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def main():
    SIZE = 128
    cx = SIZE // 2
    cy = SIZE // 2

    # Colors
    DARK_PURPLE = (45, 15, 80)     # #2D0F50
    VIBRANT_PURPLE = (120, 40, 200) # #7828C8
    BRIGHT_BLUE = (60, 130, 246)    # #3C82F6
    CYAN_ACCENT = (6, 182, 212)     # #06B6D4
    WHITE = (255, 255, 255)
    GLOW_PURPLE = (150, 60, 220, 80)  # Semi-transparent purple glow

    pixels = [[(0, 0, 0, 0) for _ in range(SIZE)] for _ in range(SIZE)]

    for y in range(SIZE):
        for x in range(SIZE):
            # Normalize coordinates to [-1, 1]
            nx = (x - cx) / cx
            ny = (y - cy) / cy

            # Distance from center
            dist = (nx ** 2 + ny ** 2) ** 0.5

            # Background: rounded rectangle with gradient
            rect_w = 110
            rect_h = 110
            corner_r = 24

            inside_rect = is_inside_rounded_rect(x, y, cx, cy, rect_w, rect_h, corner_r)

            if not inside_rect:
                pixels[y][x] = (0, 0, 0, 0)
                continue

            # Gradient: top-left to bottom-right (purple → blue)
            t_grad = (nx + 1) * 0.3 + (ny + 1) * 0.2
            t_grad = max(0.0, min(1.0, t_grad))

            bg_color = lerp_color(VIBRANT_PURPLE, BRIGHT_BLUE, t_grad)

            # Add subtle inner shadow (darker at edges)
            edge_dist = min(
                x - (cx - rect_w / 2),
                (cx + rect_w / 2) - x,
                y - (cy - rect_h / 2),
                (cy + rect_h / 2) - y,
            )
            shadow_factor = smoothstep(0, 20, edge_dist)
            bg_color = lerp_color((0, 0, 0), bg_color, shadow_factor)

            # ── Draw stylized "A" letter mark ──
            # The "A" is formed by two angled lines meeting at the top
            # with a horizontal crossbar
            r, g, b = bg_color

            # Normalize for letter drawing (-1 to 1, centered)
            lx = nx
            ly = ny

            # "A" shape parameters
            a_width = 0.55
            a_height = 0.6
            a_thickness = 0.12
            a_bar_y = 0.1  # crossbar position (relative to center)

            # Normalized vertical position: 0 at bottom, 1 at top
            a_t = (a_height - ly) / (2 * a_height)

            # Crossbar: horizontal line at ~40% from bottom
            crossbar_y = -0.15
            crossbar_width = 0.4

            # Check if pixel is near the "A" shape
            in_letter = False

            # Left leg: from bottom-left (-a_width/2) to top-center (0)
            if ly >= -a_height and ly <= a_height:
                expected_x = -a_width / 2 + a_width / 2 * a_t
                if abs(lx - expected_x) < a_thickness:
                    in_letter = True

            # Right leg: from bottom-right (a_width/2) to top-center (0)
            if ly >= -a_height and ly <= a_height:
                expected_x = a_width / 2 - a_width / 2 * a_t
                if abs(lx - expected_x) < a_thickness:
                    in_letter = True

            # Crossbar
            if abs(ly - crossbar_y) < a_thickness * 0.8 and abs(lx) < crossbar_width:
                in_letter = True

            # Top point (apex)
            if ly <= -a_height + a_thickness * 2 and abs(lx) < a_thickness * 1.5:
                in_letter = True

            # Bottom connection (base of A)
            if ly >= a_height - a_thickness * 1.5 and abs(lx) < a_width * 0.45:
                in_letter = True

            if in_letter:
                # Letter color: white with slight glow
                glow = 1.0
                # Add cyan/purple gradient to the letter
                letter_t = (ly + a_height) / (2 * a_height)
                letter_color = lerp_color(CYAN_ACCENT, WHITE, letter_t)

                # Glow effect - extend the letter slightly
                glow_factor = 1.0

                r = int(lerp(r, letter_color[0], glow_factor))
                g = int(lerp(g, letter_color[1], glow_factor))
                b = int(lerp(b, letter_color[2], glow_factor))

            # ── Subtle grid dots (tech texture) ──
            if not in_letter:
                grid_size = 16
                gx = x % grid_size
                gy = y % grid_size
                if (gx == grid_size // 2 or gy == grid_size // 2) and (x > 20 and x < SIZE - 20 and y > 20 and y < SIZE - 20):
                    dot_brightness = 0.08
                    r = int(lerp(r, 255, dot_brightness))
                    g = int(lerp(g, 255, dot_brightness))
                    b = int(lerp(b, 255, dot_brightness))

            # ── Small decorative dots around the letter ──
            if not in_letter:
                # Small dots at specific positions
                dot_positions = [
                    (-0.35, -0.55, 3),   # top-left
                    (0.35, -0.55, 3),    # top-right
                    (-0.5, 0.5, 2.5),    # bottom-left
                    (0.5, 0.5, 2.5),     # bottom-right
                ]
                for dot_x, dot_y, dot_r in dot_positions:
                    dx = (nx - dot_x) * cx
                    dy = (ny - dot_y) * cy
                    if dx * dx + dy * dy < dot_r * dot_r:
                        dot_color = CYAN_ACCENT
                        blend = 0.9
                        r = int(lerp(r, dot_color[0], blend))
                        g = int(lerp(g, dot_color[1], blend))
                        b = int(lerp(b, dot_color[2], blend))

            # Clamp all color values to 0-255 range
            pixels[y][x] = (
                max(0, min(255, int(r))),
                max(0, min(255, int(g))),
                max(0, min(255, int(b))),
                255,
            )

    # Create PNG
    png_data = create_png(SIZE, SIZE, pixels)

    with open('icon.png', 'wb') as f:
        f.write(png_data)

    print(f'Generated icon.png: {SIZE}x{SIZE} PNG, {len(png_data)} bytes')


if __name__ == '__main__':
    main()
