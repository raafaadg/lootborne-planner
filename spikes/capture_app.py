"""Capture the Lootborne Planner window (PrintWindow) for visual checks. Usage: python capture_app.py out.png"""
import ctypes
import sys

from s2_printwindow import grab

user32 = ctypes.WinDLL("user32")
hwnd = user32.FindWindowW(None, "Lootborne Planner")
if not hwnd:
    sys.exit("window not found")
ok, img = grab(hwnd, "printwindow")
img.convert("RGB").save(sys.argv[1] if len(sys.argv) > 1 else "out/app.png")
print("saved", img.size)
