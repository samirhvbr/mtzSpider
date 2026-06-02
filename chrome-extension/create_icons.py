#!/usr/bin/env python3
"""Gera ícones PNG para a extensão Chrome usando apenas bibliotecas padrão."""
import struct, zlib, os

def make_png(size, color_outer=(22,163,74), color_inner=(255,255,255)):
    """Gera PNG de 'size x size' — círculo verde com 'M' branco."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    # Fundo arredondado
    r = size // 7
    draw.rounded_rectangle([0,0,size-1,size-1], radius=r, fill=(*color_outer, 255))
    # Letra M
    fs = int(size * 0.60)
    try:
        from PIL import ImageFont
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", fs)
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0,0), "M", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1] + int(size * 0.04)
    draw.text((x, y), "M", fill=(255,255,255,255), font=font)
    return img

out = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(out, exist_ok=True)

try:
    for sz in [16, 48, 128]:
        img = make_png(sz)
        img.save(os.path.join(out, f"icon{sz}.png"), "PNG")
    print("Ícones gerados com Pillow!")
except ImportError:
    # Fallback: PNG mínimo verde sem texto
    def minimal_png(size):
        def chunk(name, data):
            c = zlib.crc32(name + data) & 0xffffffff
            return struct.pack(">I", len(data)) + name + data + struct.pack(">I", c)
        w = h = size
        raw = b""
        for y in range(h):
            row = b"\x00"
            for x in range(w):
                # Círculo preenchido simples
                cx, cy = w/2, h/2
                dist = ((x-cx)**2 + (y-cy)**2) ** 0.5
                if dist < cx * 0.9:
                    row += bytes([22, 163, 74, 255])
                else:
                    row += bytes([0, 0, 0, 0])
            raw += row
        compressed = zlib.compress(raw)
        ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
        # RGBA = color_type 6
        ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
        data  = b"\x89PNG\r\n\x1a\n"
        data += chunk(b"IHDR", ihdr)
        data += chunk(b"IDAT", compressed)
        data += chunk(b"IEND", b"")
        return data

    for sz in [16, 48, 128]:
        with open(os.path.join(out, f"icon{sz}.png"), "wb") as f:
            f.write(minimal_png(sz))
    print("Ícones mínimos gerados (sem Pillow).")
