#!/usr/bin/env python3
"""Compose a macOS-style app icon: white squircle background with the paw centered.

Inputs : icon-source.png (raw paw, transparent background)
Outputs: icon-1024.png (1024x1024, ready for dock + sips iconset)

Why a squircle background?
  Chrome/Notes/Mail/등 macOS native apps 모두 둥근 사각형(squircle) 배경에
  로고가 들어간다. 발바닥만 단독으로 띄우면 dock에서 떠 보인다.

  Apple's exact icon shape is a superellipse with n=5, but a rounded rectangle
  with corner radius ≈ 22.37% × side length is visually indistinguishable
  for users and is what most third-party design tools export.
"""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "icon-source.png"
OUT = HERE / "icon-1024.png"

SIZE = 1024
CORNER = round(SIZE * 0.2237)   # macOS squircle approximation
# 흰 배경에 발바닥이 차지할 가시 영역. 너무 작으면 dock에서 작아 보이고,
# 너무 크면 squircle 모서리에 닿아서 안 예쁨. 0.62 = 가시 영역 635px.
CONTENT_RATIO = 0.62

def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}")

    # 1) 흰 squircle 마스크
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (SIZE, SIZE)], CORNER, fill=255)

    # 2) 흰 배경 + squircle 마스크 적용
    bg = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255))
    bg.putalpha(mask)

    # 3) 발바닥 로딩 — 알파 트림으로 실제 차지하는 박스만 추출 (여백 무시)
    paw = Image.open(SRC).convert("RGBA")
    bbox = paw.getbbox()  # 알파>0 영역의 경계
    if bbox:
        paw = paw.crop(bbox)

    # 4) 가시 영역 안에 맞춰 비율 유지 리사이즈
    target = int(SIZE * CONTENT_RATIO)
    ratio = min(target / paw.width, target / paw.height)
    new_w, new_h = max(1, round(paw.width * ratio)), max(1, round(paw.height * ratio))
    paw = paw.resize((new_w, new_h), Image.LANCZOS)

    # 5) 중앙 정렬 — 시각적 균형 위해 살짝 위로 (광학 보정, 1.5%)
    x = (SIZE - new_w) // 2
    y = (SIZE - new_h) // 2 - round(SIZE * 0.015)
    bg.alpha_composite(paw, (x, y))

    # 6) 살짝의 그림자 보조 — squircle 안쪽 inner shadow로 입체감
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([(0, 0), (SIZE - 1, SIZE - 1)], CORNER, outline=(0, 0, 0, 40), width=2)
    shadow = shadow.filter(ImageFilter.GaussianBlur(1.2))
    bg.alpha_composite(shadow)

    bg.save(OUT, "PNG")
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")

if __name__ == "__main__":
    main()
