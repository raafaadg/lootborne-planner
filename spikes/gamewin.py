"""Shared helpers for the spikes: locate the Lootborne window and capture it."""
import ctypes
from ctypes import wintypes

import psutil
from PIL import ImageGrab

user32 = ctypes.WinDLL("user32", use_last_error=True)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor aware: real pixel coordinates
except OSError:
    pass

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def game_pid():
    for p in psutil.process_iter(["name", "pid"]):
        if (p.info["name"] or "").lower() == "lootborne.exe":
            return p.info["pid"]
    return None


def game_hwnd(pid=None):
    pid = pid or game_pid()
    found = []

    def cb(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls, 64)
            if cls.value == "UnityWndClass":
                found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None


def window_rect(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def is_foreground(hwnd):
    return user32.GetForegroundWindow() == hwnd


def capture(hwnd=None):
    """Grab the game window region from the desktop (layered windows included)."""
    hwnd = hwnd or game_hwnd()
    bbox = window_rect(hwnd)
    return ImageGrab.grab(bbox=bbox, include_layered_windows=True, all_screens=True), bbox
