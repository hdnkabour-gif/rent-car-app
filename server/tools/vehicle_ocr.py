#!/usr/bin/env python3
"""Read-only advisory OCR for Moroccan rental fleet images: registration plates and odometers.
Never verifies a plate, a car's identity or a mileage reading automatically.
Do not pass genuine identity images into tests.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

# Eastern Arabic and Persian numerals are normalized; Arabic plate letters remain Arabic.
DIGIT_TRANSLATION = str.maketrans(
    "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹",
    "01234567890123456789",
)

def normalize_digits(value: str) -> str:
    return value.translate(DIGIT_TRANSLATION)

def extract_plate_candidates(raw_text: str) -> dict:
    text = normalize_digits(raw_text).upper().replace("\u200f", "").replace("\u200e", "")
    # A photo may include a dealer name, stickers and surrounding numbers.
    # Return text and plausible components, never fabricate a Moroccan plate from guesses.
    blocks = re.findall(r"(?<![0-9])[0-9]{1,6}(?![0-9])", text)
    letters = re.findall(r"[\u0621-\u064a]", text)
    suggestions: dict = {}
    if blocks:
        suggestions["numberBlocks"] = {
            "value": " / ".join(blocks[:4]),
            "confidence": 0.4,
            "basis": "unverified_plate_segments"
        }
    if letters:
        suggestions["arabicLetters"] = {
            "value": "".join(letters[:3]),
            "confidence": 0.35,
            "basis": "unverified_arabic_letters"
        }
    return {"fields": suggestions, "requiresHumanReview": True, "kind": "vehicle_plate"}

def extract_odometer_candidates(raw_text: str) -> dict:
    text = normalize_digits(raw_text).upper()
    text = text.replace("\u00a0", " ").replace(",", " ")
    # OCR often loses the KM/ODO caption; in that case return several candidates,
    # including possible trip values, rather than selecting a single odometer reading.
    hits = []
    for match in re.finditer(r"(?<!\d)(\d{1,3}(?:[ .]\d{3}){1,2}|\d{3,7})(?:\s*(?:KM|KMS))?(?!\d)", text):
        digits = re.sub(r"\D", "", match.group(1))
        value = int(digits)
        if 0 <= value <= 2_000_000:
            left = text[max(0, match.start()-12):match.start()]
            right = text[match.end():match.end()+8]
            labeled = bool(re.search(r"ODO|ODOM|KILOMET|\bKM\b", left + " " + right))
            hits.append({"value": value, "confidence": 0.7 if labeled else 0.3,
                         "basis": "odo_label" if labeled else "unverified_numeric_candidate"})
    deduped = []
    seen = set()
    for item in sorted(hits, key=lambda x: -x["confidence"]):
        if item["value"] not in seen:
            deduped.append(item)
            seen.add(item["value"])
    return {"kind": "vehicle_odometer", "requiresHumanReview": True,
            "candidates": deduped[:8], "warning": "Trip, speed and odometer can be confused"}

def read_vehicle_image(filename: str, kind: str) -> dict:
    if kind not in ("vehicle_plate", "vehicle_odometer"):
        raise ValueError("Only plate and odometer OCR is supported")
    import cv2
    import pytesseract
    path = Path(filename)
    if not path.is_file() or path.stat().st_size > 20_000_000:
        raise ValueError("Image missing or too large")
    img = cv2.imread(str(path))
    if img is None or img.shape[0] * img.shape[1] > 25_000_000:
        raise ValueError("Invalid image")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0,tileGridSize=(8,8)).apply(gray)
    # Plate OCR includes Arabic script. Odometer recognition is mainly Arabic/Latin numerals.
    language = "eng+ara" if kind == "vehicle_plate" else "eng"
    raw = pytesseract.image_to_string(gray, lang=language,
            config="--psm 11" if kind == "vehicle_plate" else "--psm 6", timeout=20)
    result = extract_plate_candidates(raw) if kind == "vehicle_plate" else extract_odometer_candidates(raw)
    result["engine"] = "tesseract-local"
    return result

if __name__ == "__main__":
    try:
        if len(sys.argv)!=3: raise ValueError("File and mode required")
        print(json.dumps(read_vehicle_image(sys.argv[1],sys.argv[2]), ensure_ascii=False))
    except Exception:
        print(json.dumps({"error":"vehicle_ocr_unavailable_or_unreadable"}))
        sys.exit(2)
