"""S2b - Capture only the game's own pixels via PrintWindow(PW_RENDERFULLCONTENT) and via
DWM-independent BitBlt of the window DC, so the capture does not depend on what is behind or
over the transparent overlay window."""
import ctypes
import os
import time
from ctypes import wintypes

from PIL import Image

from gamewin import game_hwnd, window_rect

OUT = os.path.join(os.path.dirname(__file__), "out", "s2")
user32 = ctypes.WinDLL("user32")
gdi32 = ctypes.WinDLL("gdi32")


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def grab(hwnd, mode):
    l, t, r, b = window_rect(hwnd)
    w, h = r - l, b - t
    hdc_win = user32.GetWindowDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    bmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
    gdi32.SelectObject(hdc_mem, bmp)
    if mode == "printwindow":
        ok = user32.PrintWindow(hwnd, hdc_mem, 2)  # PW_RENDERFULLCONTENT
    else:
        ok = gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_win, 0, 0, 0x00CC0020)  # SRCCOPY
    bi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_win)
    return ok, Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1)


def main():
    os.makedirs(OUT, exist_ok=True)
    hwnd = game_hwnd()
    for mode in ("printwindow", "bitblt"):
        t0 = time.perf_counter()
        ok, img = grab(hwnd, mode)
        dt = (time.perf_counter() - t0) * 1000
        alpha = img.getchannel("A")
        hist = alpha.histogram()
        opaque = sum(hist[250:]) / (img.size[0] * img.size[1])
        rgb = img.convert("RGB")
        black = rgb.getcolors(1 << 22)
        top = sorted(black, reverse=True)[:3] if black else []
        path = os.path.join(OUT, f"{mode}.png")
        img.save(path)
        print(f"{mode}: ok={ok} {dt:.0f} ms size={img.size} alpha_opaque={opaque:.2%} "
              f"alpha_min={alpha.getextrema()} top_colors={top} -> {path}")


if __name__ == "__main__":
    main()
