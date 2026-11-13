"""Offline integration smoke: actual Tesseract OCR of an entirely synthetic image."""
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image, ImageDraw, ImageFont
from document_ocr import ocr_document

def main() -> None:
    with TemporaryDirectory(prefix="fleetora-ocr-smoke-") as tmp:
        file = Path(tmp) / "synthetic.png"
        image = Image.new("RGB", (1100, 320), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.load_default(size=55)
        draw.text((90, 50), "SYNTHETIC TEST - NOT A REAL ID", font=font, fill="black")
        draw.text((120, 180), "CIN: AB1234567", font=font, fill="black")
        image.save(file)
        result = ocr_document(str(file), "id_front")
        assert result["requiresHumanReview"] is True
        assert result["kind"] == "id_front"
        assert result["fields"].get("documentNumber", {}).get("value") == "AB1234567", (
            "Synthetic test number not recognized by deployed OCR language packs"
        )
        assert result["quality"]["blurVariance"] >= 0
        assert len(result["visualHash"]) == 16
        print("OCR_IMAGE_SMOKE PASS: synthetic AB1234567 detected locally, review required.")

if __name__ == "__main__":
    main()
