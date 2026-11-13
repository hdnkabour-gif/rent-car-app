#!/usr/bin/env python3
"""Local-only OCR proposals. Never auto-update identities or upload documents to third parties.
Runtime requires: Python3, opencv-python-headless, pytesseract, tesseract-ocr;
PDFs additionally require pdftoppm. Exit 2 means OCR unavailable or unreadable.
"""
from __future__ import annotations
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

KINDS = {'id_front', 'id_back', 'passport', 'licence_front', 'licence_back', 'residence_permit', 'other'}

def mrz_check(value: str, check: str) -> bool:
    if not check.isdigit():
        return False
    def number(char: str) -> int:
        if '0' <= char <= '9': return ord(char) - 48
        if 'A' <= char <= 'Z': return ord(char) - 55
        return 0
    return sum(number(c) * (7, 3, 1)[i % 3] for i, c in enumerate(value)) % 10 == int(check)

def extract_passport_mrz(text: str) -> dict:
    rows = [re.sub(r'[^A-Z0-9<]', '', line.upper()) for line in text.splitlines()]
    for i, first in enumerate(rows[:-1]):
        second = rows[i + 1]
        if len(first) != 44 or len(second) != 44 or not first.startswith('P<'):
            continue
        if not mrz_check(second[:9], second[9]):
            continue
        result = {'documentNumber': {'value': second[:9].replace('<',''), 'confidence': .95, 'basis': 'mrz_checksum'}}
        if second[10:13].replace('<',''):
            result['nationality'] = {'value': second[10:13].replace('<',''), 'confidence': .8, 'basis': 'mrz'}
        if mrz_check(second[13:19],second[19]):
            result['birthDateYYMMDD'] = {'value': second[13:19], 'confidence': .9, 'basis': 'mrz_checksum'}
        if mrz_check(second[21:27],second[27]):
            result['expiryDateYYMMDD'] = {'value': second[21:27], 'confidence': .9, 'basis': 'mrz_checksum'}
        names = first[5:].split('<<',1)
        full = ' '.join(z for z in [names[1].replace('<',' ').strip() if len(names)>1 else '', names[0].replace('<',' ').strip()] if z)
        if full: result['fullName'] = {'value': full, 'confidence': .7, 'basis': 'mrz'}
        return result
    return {}

def proposed_fields(text: str, kind: str) -> dict:
    if kind == 'passport':
        return extract_passport_mrz(text)
    if kind in ('id_front','id_back'):
        matches = re.findall(r'(?<![A-Z0-9])([A-Z]{1,2}\s?[0-9]{4,8})(?![A-Z0-9])', text.upper())
        if matches:
            return {'documentNumber': {'value': re.sub(r'\s+','', matches[0]),
                    'confidence': .45, 'basis': 'unverified_pattern'}}
    return {}

def hamming_distance(a: str, b: str) -> int:
    if not re.fullmatch(r'[0-9a-f]{16}',a) or not re.fullmatch(r'[0-9a-f]{16}',b):
        raise ValueError('Expected two hexadecimal visual fingerprints')
    return (int(a,16) ^ int(b,16)).bit_count()

def ocr_document(filename: str, kind: str) -> dict:
    if kind not in KINDS: raise ValueError('Invalid document kind')
    import cv2
    import numpy as np
    import pytesseract
    path = Path(filename)
    if not path.is_file() or path.stat().st_size > 20_000_000:
        raise ValueError('File absent or too large')
    with tempfile.TemporaryDirectory(prefix='fleetora-ocr-') as working:
        source = path
        if path.suffix.lower() == '.pdf':
            prefix = str(Path(working) / 'page')
            subprocess.run(['pdftoppm','-f','1','-singlefile','-r','220','-png',str(path),prefix],
                           check=True, timeout=20, capture_output=True)
            source = Path(prefix + '.png')
        img = cv2.imread(str(source))
        if img is None or img.shape[0] * img.shape[1] > 25_000_000:
            raise ValueError('Image cannot be processed')
        gray = cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
        height,width = gray.shape
        blur = float(cv2.Laplacian(gray,cv2.CV_64F).var())
        brightness = float(gray.mean())
        warnings = []
        if blur < 65: warnings.append('blur_or_low_detail')
        if brightness < 55: warnings.append('too_dark')
        if brightness > 245: warnings.append('too_bright')
        if min(height,width) < 450: warnings.append('low_resolution')
        _,binary = cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        coords = np.column_stack(np.where(binary > 0))
        rotation = 0.
        if 150 < len(coords) < 4_000_000:
            angle = cv2.minAreaRect(coords.astype('float32'))[-1]
            rotation = -(90 + angle) if angle < -45 else -angle
            if abs(rotation) > 15: rotation = 0.
        if abs(rotation) > .5:
            transform = cv2.getRotationMatrix2D((width/2,height/2),rotation,1)
            gray = cv2.warpAffine(gray,transform,(width,height),flags=cv2.INTER_CUBIC,
                                  borderMode=cv2.BORDER_REPLICATE)
        gray = cv2.createCLAHE(clipLimit=2,tileGridSize=(8,8)).apply(gray)
        mini = cv2.resize(gray,(9,8),interpolation=cv2.INTER_AREA)
        bits = mini[:,:-1] > mini[:,1:]
        fingerprint = f'{sum(int(bit) << (63-i) for i,bit in enumerate(bits.flat)):016x}'
        data = pytesseract.image_to_data(gray,config='--psm 6',
                    output_type=pytesseract.Output.DICT,timeout=20)
        words=[]; confidences=[]
        for word,confidence in zip(data['text'],data['conf']):
            if word.strip():
                words.append(word.strip())
                if float(confidence)>=0: confidences.append(float(confidence))
        fields = proposed_fields('\n'.join(words),kind)
        if kind == 'passport':
            lines = pytesseract.image_to_string(gray,config='--psm 3',timeout=20)
            fields.update(proposed_fields(lines,kind))
        return {'engine':'tesseract-local','kind':kind,'requiresHumanReview':True,
                'fields':fields,'visualHash':fingerprint,
                'quality':{'blurVariance':round(blur,1),'brightness':round(brightness,1),
                  'deskewDegrees':round(rotation,1),'averageWordConfidence':
                  round(sum(confidences)/len(confidences),1) if confidences else 0},
                'warnings':warnings}

def main() -> int:
    try:
        if len(sys.argv)!=3: raise ValueError('File path and kind required')
        print(json.dumps(ocr_document(sys.argv[1],sys.argv[2]),ensure_ascii=False))
        return 0
    except Exception:
        # Never put file paths, raw OCR text or other identity data into logs.
        print(json.dumps({'error':'ocr_unavailable_or_unreadable'}))
        return 2

if __name__=='__main__': sys.exit(main())
