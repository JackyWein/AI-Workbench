#!/usr/bin/env python3
"""Generates the application icon.

No image library is available in the build environment, so the icon is drawn
here and written as a PNG directly. Keeping it as code means the icon is
reproducible and reviewable instead of an opaque binary nobody can change.

The design follows the application's own restraint: a quiet dark tile with three
accent bars standing for streaming sessions. No gradients, no emoji.
"""

import struct
import zlib
from pathlib import Path

SIZE = 512
SUPERSAMPLE = 4  # rendered large, then averaged down for smooth edges

BACKGROUND = (20, 22, 26, 255)  # matches --surface-raised in the dark theme
ACCENT = (110, 168, 254, 255)  # matches --accent
ACCENT_DIM = (110, 168, 254, 150)


def rounded_rect(x: float, y: float, w: float, h: float, r: float):
    """Returns a predicate telling whether a point is inside a rounded rect.

    The point is clamped to the inner rectangle and the distance to that clamped
    position is compared against the radius. This stays correct when the radius
    is exactly half the height, where corner circles coincide.
    """
    r = min(r, w / 2, h / 2)

    def inside(px: float, py: float) -> bool:
        if px < x or px > x + w or py < y or py > y + h:
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r

    return inside


def blend(base, layer):
    """Alpha-composites layer over base."""
    alpha = layer[3] / 255
    return tuple(
        round(layer[i] * alpha + base[i] * (1 - alpha)) for i in range(3)
    ) + (255,)


def render() -> bytes:
    scale = SIZE * SUPERSAMPLE
    unit = scale / SIZE

    tile = rounded_rect(0, 0, scale, scale, 0.22 * scale)

    bars = []
    bar_height = 44 * unit
    bar_gap = 38 * unit
    bar_left = 128 * unit
    widths = (256, 188, 120)
    colors = (ACCENT, ACCENT, ACCENT_DIM)
    total = len(widths) * bar_height + (len(widths) - 1) * bar_gap
    top = (scale - total) / 2
    for index, width in enumerate(widths):
        y = top + index * (bar_height + bar_gap)
        bars.append(
            (
                rounded_rect(bar_left, y, width * unit, bar_height, bar_height / 2),
                colors[index],
            )
        )

    rows = []
    for out_y in range(SIZE):
        row = bytearray()
        for out_x in range(SIZE):
            accum = [0, 0, 0, 0]
            for sy in range(SUPERSAMPLE):
                py = out_y * SUPERSAMPLE + sy + 0.5
                for sx in range(SUPERSAMPLE):
                    px = out_x * SUPERSAMPLE + sx + 0.5
                    if not tile(px, py):
                        pixel = (0, 0, 0, 0)
                    else:
                        pixel = BACKGROUND
                        for inside, color in bars:
                            if inside(px, py):
                                pixel = blend(pixel, color)
                                break
                    for i in range(4):
                        accum[i] += pixel[i]
            samples = SUPERSAMPLE * SUPERSAMPLE
            row.extend(round(value / samples) for value in accum)
        rows.append(bytes(row))
    return b"".join(b"\x00" + row for row in rows)


def write_png(path: Path, raw: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    target = Path(__file__).resolve().parent.parent / "apps/desktop/build/icon.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    write_png(target, render())
    print(f"wrote {target} ({target.stat().st_size} bytes)")
