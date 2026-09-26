"""Template location on PrintWindow captures.

The UI is flat pixel art, so a few anchor pixels of the template match (almost) exactly wherever
the player dragged the panel: filter candidates by anchor colours, then verify the full crop.
"""
import numpy as np


def to_arr(img):
    return np.asarray(img.convert("RGB"), dtype=np.int16)


def _anchors(nd, count=6):
    h, w, _ = nd.shape
    bright = nd.sum(axis=2)
    ys, xs = np.nonzero(bright > 120)
    if len(ys) == 0:
        raise ValueError("template has no bright pixels")
    idx = np.linspace(0, len(ys) - 1, count).astype(int)
    return [(int(ys[i]), int(xs[i])) for i in idx]


def locate(hay_img, needle_img, tol=10, max_mean_err=14.0):
    """Return (x, y, err) of the best match, or None."""
    hay, nd = to_arr(hay_img), to_arr(needle_img)
    H, W, _ = hay.shape
    h, w, _ = nd.shape
    anchors = _anchors(nd)
    ay, ax = anchors[0]
    mask = (np.abs(hay - nd[ay, ax]) <= tol).all(axis=2)
    cy, cx = np.nonzero(mask)
    cy, cx = cy - ay, cx - ax
    keep = (cy >= 0) & (cx >= 0) & (cy + h <= H) & (cx + w <= W)
    cy, cx = cy[keep], cx[keep]
    for y0, x0 in anchors[1:]:
        if len(cy) == 0:
            return None
        ok = (np.abs(hay[cy + y0, cx + x0] - nd[y0, x0]) <= tol).all(axis=1)
        cy, cx = cy[ok], cx[ok]
    best = None
    for y, x in zip(cy[:200], cx[:200]):
        err = float(np.abs(hay[y:y + h, x:x + w] - nd).mean())
        if best is None or err < best[2]:
            best = (int(x), int(y), err)
    return best if best and best[2] <= max_mean_err else None
