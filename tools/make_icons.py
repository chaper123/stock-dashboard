"""產生網站圖示（site/icons/）：深色底、三根 K 棒、三條買區色帶。只用標準庫（2 倍超取樣後縮小）。

用法：py -3.14 tools/make_icons.py
圖形以 100×100 座標描述，site/icons/icon.svg 用同一組座標。
"""
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "icons"
BG = (26, 26, 25)
BLUE = (57, 135, 229)
UP = (230, 103, 103)
DOWN = (25, 158, 112)
# (x0, y0, x1, y1, 顏色, 不透明度)
SHAPES = [
    (14, 58, 86, 64, BLUE, 0.35), (14, 68, 86, 74, BLUE, 0.6), (14, 78, 86, 84, BLUE, 0.9),
    (28.5, 22, 30.5, 54, UP, 1), (24, 30, 35, 48, UP, 1),
    (49, 30, 51, 56, DOWN, 1), (44.5, 36, 55.5, 52, DOWN, 1),
    (70, 12, 72, 44, UP, 1), (65.5, 18, 76.5, 38, UP, 1),
]


def render(size, maskable):
    ss = 2
    n = size * ss
    px = [[(0, 0, 0, 0)] * n for _ in range(n)]
    r = 0 if maskable else 22 * n / 100
    for y in range(n):
        for x in range(n):
            if r:
                cx = min(max(x + 0.5, r), n - r)
                cy = min(max(y + 0.5, r), n - r)
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r:
                    continue
            px[y][x] = (*BG, 255)
    # 可遮罩圖示：內容縮到中間 70%，避開系統裁切
    scale, off = (0.7, 15) if maskable else (1, 0)
    for x0, y0, x1, y1, c, a in SHAPES:
        X0, X1 = [round((off + v * scale) * n / 100) for v in (x0, x1)]
        Y0, Y1 = [round((off + v * scale) * n / 100) for v in (y0, y1)]
        for y in range(Y0, Y1):
            for x in range(X0, X1):
                b = px[y][x]
                px[y][x] = (*[round(b[i] * (1 - a) + c[i] * a) for i in range(3)], 255)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(ss):
                for dx in range(ss):
                    p = px[y * ss + dy][x * ss + dx]
                    for i in range(4):
                        acc[i] += p[i]
            row += bytes(v // (ss * ss) for v in acc)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


def svg():
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
             f'<rect width="100" height="100" rx="22" fill="rgb{BG}"/>']
    for x0, y0, x1, y1, c, a in SHAPES:
        parts.append(f'<rect x="{x0}" y="{y0}" width="{x1 - x0:g}" height="{y1 - y0:g}" fill="rgb{c}"'
                     + (f' fill-opacity="{a}"' if a < 1 else "") + "/>")
    parts.append("</svg>")
    return "\n".join(parts).replace(", ", ",") + "\n"


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, size, mask in (("icon-192.png", 192, False), ("icon-512.png", 512, False), ("maskable-512.png", 512, True)):
        (OUT / name).write_bytes(render(size, mask))
        print(name, (OUT / name).stat().st_size)
    (OUT / "icon.svg").write_text(svg(), encoding="utf-8")
    print("icon.svg")
