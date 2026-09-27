"""Prepare Dramatis app icons, portrait thumbnails, and review sheets."""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "apps" / "web" / "public"
MASTER = PUBLIC / "brand" / "icon-master.png"
# Keep the character and goblet legible at 60px launcher size. The original
# 1254px master remains untouched so this crop can be revised later.
HOME_ICON_CROP = (202, 325, 1052, 1175)
PORTRAIT_SOURCES = ROOT / "art" / "source" / "portraits"
CATALOG = json.loads((ROOT / "apps" / "web" / "src" / "lib" / "portrait-catalog.json").read_text(encoding="utf-8"))
NAMES_BY_NUMBER = {entry["number"]: entry["name"] for entry in CATALOG}


def app_icon(size: int, maskable: bool = False) -> Image.Image:
    art = Image.open(MASTER).convert("RGBA")
    if art.size != (1254, 1254):
        raise ValueError(f"Unexpected app icon master dimensions: {art.size}")
    art = art.crop(HOME_ICON_CROP)
    background = Image.new("RGBA", art.size, "#fff")
    background.alpha_composite(art)
    image = background.convert("RGB")
    if maskable:
        # Reserve space for Android's circle/squircle launcher masks.
        inner = image.resize((round(size * 0.9), round(size * 0.9)), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (size, size), "#fff")
        canvas.paste(inner, ((size - inner.width) // 2, (size - inner.height) // 2))
        return canvas
    return image.resize((size, size), Image.Resampling.LANCZOS)


for pixels, filename, maskable in [
    (512, "icon-512.png", False),
    (192, "icon-192.png", False),
    (512, "icon-maskable-512.png", True),
    (192, "icon-maskable-192.png", True),
    (512, "icon-home-512.png", False),
    (192, "icon-home-192.png", False),
    (512, "icon-home-maskable-512.png", True),
    (192, "icon-home-maskable-192.png", True),
    (180, "apple-touch-icon.png", False),
    (64, "favicon.png", False),
]:
    app_icon(pixels, maskable).save(PUBLIC / filename, optimize=True)

if "--icons-only" in sys.argv:
    raise SystemExit(0)

portraits = PUBLIC / "portraits"
thumbs = portraits / "thumbs"
avatars = portraits / "avatars"
thumbs.mkdir(exist_ok=True)
avatars.mkdir(exist_ok=True)
for source in sorted(PORTRAIT_SOURCES.glob("*.png")):
    with Image.open(source) as portrait:
        portrait.convert("RGB").save(portraits / f"{source.stem}.webp", "WEBP", quality=95, method=6)
        thumb = ImageOps.contain(portrait.convert("RGB"), (160, 240), Image.Resampling.LANCZOS)
        thumb.save(thumbs / f"{source.stem}.webp", "WEBP", quality=84, method=6)
        # A head-and-shoulders square keeps the entire face legible in a small
        # circular chat avatar; the tall full-body art remains available above.
        headshot = portrait.convert("RGB").crop((300, 0, 724, 424)).resize((256, 256), Image.Resampling.LANCZOS)
        headshot.save(avatars / f"{source.stem}.webp", "WEBP", quality=90, method=6)

sources = sorted(PORTRAIT_SOURCES.glob("*.png"))
if {int(source.stem) for source in sources} != set(NAMES_BY_NUMBER):
    raise ValueError("Portrait source numbers do not match portrait-catalog.json")
if sources:
    tile_width, tile_height = 280, 445
    sheet = Image.new("RGB", (tile_width * 10, tile_height * 5), "#eee9e3")
    draw = ImageDraw.Draw(sheet)
    faces = Image.new("RGB", (200 * 10, 220 * 5), "#eee9e3")
    face_draw = ImageDraw.Draw(faces)
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 20) if font_path.exists() else ImageFont.load_default()
    for source in sources:
        number = int(source.stem)
        index = number - 1
        x, y = index % 10 * tile_width, index // 10 * tile_height
        with Image.open(source) as portrait:
            preview = ImageOps.contain(portrait.convert("RGB"), (tile_width - 12, tile_height - 42))
            closeup = ImageOps.fit(portrait.convert("RGB").crop((120, 0, 904, 650)), (196, 196))
        sheet.paste(preview, (x + (tile_width - preview.width) // 2, y + 4))
        faces.paste(closeup, (index % 10 * 200 + 2, index // 10 * 220 + 2))
        draw.text((x + 10, y + tile_height - 32), f"{source.stem} · {NAMES_BY_NUMBER[number]}", fill="#231814", font=font)
        face_draw.text((index % 10 * 200 + 8, index // 10 * 220 + 198), source.stem, fill="#231814", font=font)
    for number in sorted(set(range(1, 51)) - set(NAMES_BY_NUMBER)):
        index = number - 1
        x, y = index % 10 * tile_width, index // 10 * tile_height
        draw.rectangle((x + 4, y + 4, x + tile_width - 4, y + tile_height - 44), fill="#d9d3cc")
        draw.text((x + 10, y + tile_height - 32), f"{number:02d} · 已删除", fill="#776c65", font=font)
        face_draw.text((index % 10 * 200 + 8, index // 10 * 220 + 198), f"{number:02d} · 已删除", fill="#776c65", font=font)
    sheet.save(ROOT / "art" / "review-portraits.jpg", quality=92)
    faces.save(ROOT / "art" / "review-faces.jpg", quality=92)

print(f"Prepared ten app icons and {len(list(thumbs.glob('*.webp')))} portrait, thumbnail and avatar sets.")
