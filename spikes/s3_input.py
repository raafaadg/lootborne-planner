"""S3 - Input spike: click a window-relative point with PostMessage (no cursor move) or SendInput
(cursor moved and restored), and save before/after captures to compare.

Usage: python s3_input.py <baseline|post|sendinput> <template> <tag>
The template (spikes/templates/<name>.png) is located right before the click; the click goes to its centre.
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

import numpy as np

from PIL import Image, ImageChops

from locate import locate

from gamewin import game_hwnd, is_foreground, window_rect
from s2_printwindow import grab

OUT = os.path.join(os.path.dirname(__file__), "out", "s3")
user32 = ctypes.WinDLL("user32", use_last_error=True)
WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON = 0x0200, 0x0201, 0x0202, 0x0001


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def lparam(x, y):
    return (y << 16) | (x & 0xFFFF)


def click_post(hwnd, x, y):
    user32.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lparam(x, y))
    time.sleep(0.05)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lparam(x, y))
    time.sleep(0.08)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lparam(x, y))


def click_sendinput(hwnd, x, y):
    left, top, _, _ = window_rect(hwnd)
    old = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(old))
    ex_before = user32.GetWindowLongW(hwnd, -20)
    user32.SetCursorPos(left + x, top + y)
    time.sleep(0.4)  # let UniWindowController re-evaluate hit-test/click-through under the cursor
    ex_hover = user32.GetWindowLongW(hwnd, -20)
    print(f"exstyle before=0x{ex_before & 0xFFFFFFFF:08X} hovering=0x{ex_hover & 0xFFFFFFFF:08X} "
          f"(WS_EX_TRANSPARENT={bool(ex_hover & 0x20)})")
    for flag in (0x0002, 0x0004):  # LEFTDOWN, LEFTUP
        inp = INPUT(type=0)
        inp.mi = MOUSEINPUT(0, 0, 0, flag, 0, 0)
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.08)
    time.sleep(0.05)
    user32.SetCursorPos(old.x, old.y)


def changed_px(a, b, box=None):
    d = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    if box:
        d = d.crop(box)
    return int((np.asarray(d.convert("L")) > 24).sum())


def main():
    mode, tpl_name, tag = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(OUT, exist_ok=True)
    hwnd = game_hwnd()
    fg = is_foreground(hwnd)
    _, before = grab(hwnd, "printwindow")
    tpl = Image.open(os.path.join(os.path.dirname(__file__), "templates", f"{tpl_name}.png"))
    hit = locate(before, tpl)
    if not hit:
        sys.exit(f"template {tpl_name} not found")
    x, y = hit[0] + tpl.size[0] // 2, hit[1] + tpl.size[1] // 2
    t0 = time.perf_counter()
    if mode == "post":
        click_post(hwnd, x, y)
    elif mode == "sendinput":
        click_sendinput(hwnd, x, y)
    dt = (time.perf_counter() - t0) * 1000
    time.sleep(0.9)
    _, after = grab(hwnd, "printwindow")
    before.save(os.path.join(OUT, f"{tag}_before.png"))
    after.save(os.path.join(OUT, f"{tag}_after.png"))
    after_hit = locate(after, tpl)
    total = changed_px(before, after)
    print(f"{mode} {tpl_name}@({x},{y}) foreground_before={fg} foreground_after={is_foreground(hwnd)} "
          f"input_ms={dt:.0f} changed_px={total} template_after={after_hit}")


if __name__ == "__main__":
    main()
