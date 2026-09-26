"""S2 - Screen capture spike.

Captures the game window N times, measures capture latency, checks the x3 pixel grid
and how much of the transparent window is actually opaque game UI.

Usage: python s2_capture.py [count] [interval_s]
"""
import os
import sys
import time

from gamewin import capture, game_hwnd, is_foreground, window_rect

OUT = os.path.join(os.path.dirname(__file__), "out", "s2")


def grid_score(img, scale=3):
    """Fraction of sampled 3x3 cells that are a single flat colour (pixel-art upscaled x3)."""
    w, h = img.size
    px = img.load()
    total = flat = 0
    for y in range(0, h - scale, 17 * scale):
        for x in range(0, w - scale, 17 * scale):
            for ox in range(scale):
                cell = {px[x + ox + dx, y + dy] for dx in range(scale) for dy in range(scale)}
                total += 1
                flat += len(cell) == 1
    return flat / total if total else 0


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 2
    os.makedirs(OUT, exist_ok=True)
    hwnd = game_hwnd()
    print("hwnd", hwnd, "rect", window_rect(hwnd), "foreground", is_foreground(hwnd))
    for i in range(count):
        t0 = time.perf_counter()
        img, bbox = capture(hwnd)
        dt = (time.perf_counter() - t0) * 1000
        path = os.path.join(OUT, f"cap_{i:02d}.png")
        img.save(path)
        colors = img.convert("RGB").getcolors(maxcolors=1 << 20)
        print(f"{i}: {img.size} {dt:.0f} ms grid_x3={grid_score(img.convert('RGB'), 3):.2f} "
              f"grid_x1_offset={grid_score(img.convert('RGB').crop((1, 1, img.size[0], img.size[1])), 3):.2f} "
              f"colors={len(colors) if colors else '>1M'} -> {path}")
        time.sleep(interval)


if __name__ == "__main__":
    main()
