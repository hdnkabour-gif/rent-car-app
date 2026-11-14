#!/usr/bin/env python3
"""Local-only OCR proposals. Never auto-update identities or upload documents to third parties.
Runtime requires: Python3, opencv-python-headless, pytesseract, tesseract-ocr;
PDFs additionally require pdftoppm. Exit 2 means OCR unavailable or unreadable.
"""
from __future__ import annotations
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

KINDS = {'id_front', 'id_back', 'passport', 'licence_front', 'licence_back',
         'residence_permit', 'other', 'registration', 'insurance',
         'technical_inspection', 'vignette', 'transport_authorization',
         'other_vehicle', 'contract_signed'}

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

def normalized_ocr_text(text: str) -> str:
    """Normalize Arabic/Persian numerals without guessing ambiguous letters."""
    return text.translate(str.maketrans(
        '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'
    ))


def labelled_fields(text: str, kind: str) -> dict:
    """Conservative Moroccan document hints: only values next to a known label.
    OCR evidence is not proof of authenticity. Never infer unspecified fields.
    """
    lines = [re.sub(r'\s+', ' ', line).strip()
             for line in normalized_ocr_text(text).splitlines() if line.strip()]
    plate = r'([0-9]{1,6}\s*[-|/]?\s*[\u0621-\u064aA-Za-z]\s*[-|/]?\s*[0-9]{1,3})'
    vin = r'([A-HJ-NPR-Z0-9]{17})'
    reference = r'([A-Za-z0-9][A-Za-z0-9/\-]{2,44})'
    date = r'([0-3]?[0-9][./-][01]?[0-9][./-](?:19|20)?[0-9]{2})'
    rules = {
        'registration': [
            ('plateNumber', r'immatriculation|\u0627\u0644\u062a\u0631\u0642\u064a\u0645', plate),
            ('vin', r'(?:n[°o.]?\s*(?:de|du)?\s*)?(?:ch[âa]ssis|vin|\u0627\u0644\u0647\u064a\u0643\u0644)', vin),
            ('firstRegistrationDate', r'1[èe]re\s*m[.]?c|premi[èe]re\s*mise', date),
        ],
        'insurance': [
            ('policyNumber', r'(?:n[°o.]?\s*)?(?:police|contrat\s*d.assurance)', reference),
            ('plateNumber', r'immatriculation', plate),
            ('startDate', r'date\s*d.effet|du\s*:', date),
            ('expiryDate', r'(?:fin\s*(?:de)?\s*(?:validit[ée]|garantie)|expire|au\s*:)', date),
        ],
        'technical_inspection': [
            ('plateNumber', r'immatriculation', plate),
            ('inspectionDate', r'date\s*(?:de\s*)?(?:contr[ôo]le|visite)', date),
            ('nextInspectionDate', r'(?:prochain|validit[ée]|limite)', date),
        ],
        'vignette': [
            ('plateNumber', r'immatriculation', plate),
            ('paymentDate', r'date\s*(?:de\s*)?(?:paiement|versement)', date),
        ],
        'transport_authorization': [
            ('documentNumber', r'(?:n[°o.]?\s*)?(?:autorisation|r[ée]f[ée]rence)', reference),
        ],
        'contract_signed': [
            ('contractNumber', r'(?:contrat\s*(?:de\s*location)?\s*)?n[°o.]|n[°o.]\s*contrat', reference),
            ('plateNumber', r'immatriculation', plate),
        ],
    }
    out = {}
    for key, label, value_pattern in rules.get(kind, []):
        lab = re.compile(label, re.IGNORECASE)
        val = re.compile(value_pattern, re.IGNORECASE)
        for i, line in enumerate(lines):
            match = lab.search(line)
            if not match:
                continue
            rest = line[match.end():].lstrip(' \t:;=#.\u00b0-')
            found = val.search(rest)
            if not found and i + 1 < len(lines) and not rest:
                found = val.search(lines[i+1])
            if found:
                out[key] = {'value': found[1].strip(), 'confidence': .4,
                            'basis': 'labelled_unverified'}
                break
    return out

def proposed_fields(text: str, kind: str) -> dict:
    if kind == 'passport':
        return extract_passport_mrz(text)
    if kind in ('registration','insurance','technical_inspection','vignette',
                'transport_authorization','other_vehicle','contract_signed'):
        return labelled_fields(text,kind)
    # An unlabelled letter/number string might be unrelated to the CIN.
    # Suggest only an alphanumeric candidate beside an identity-number label.
    if kind in ('id_front', 'id_back'):
        lines = [re.sub(r'\s+', ' ', line.upper()).strip()
                 for line in normalized_ocr_text(text).splitlines() if line.strip()]
        label_pattern = re.compile(
            r'(?<![A-Z])(?:CNIE|CIN|C\.?N\.?I\.?E?\.?|IDENTIT[EÉ]|IDENTITY|'
            r'CARTE[\s-]*NATIONALE|NATIONAL[\s-]*ID|رقم[\s:]*البطاقة|'
            r'البطاقة[\s:]*الوطنية)(?![A-Z])'
        )
        number_pattern = re.compile(r'(?<![A-Z0-9])([A-Z]{1,2}\s?[0-9]{4,8})(?![A-Z0-9])')
        for i, line in enumerate(lines):
            label = label_pattern.search(line)
            if not label:
                continue
            tail = line[label.end():]
            match = number_pattern.search(tail)
            if not match and i + 1 < len(lines) and not tail.strip(' :#°Nº\t-'):
                match = number_pattern.search(lines[i + 1])
            if match:
                return {'documentNumber': {
                    'value': re.sub(r'\s+', '', match[1]),
                    'confidence': .45,
                    'basis': 'unverified_labelled_pattern'
                }}
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
    languages = os.environ.get('FLEETORA_OCR_LANG','eng')
    if not re.fullmatch(r'[a-z]{3}(\+[a-z]{3}){0,4}', languages):
        raise ValueError('Invalid Tesseract languages')
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
        data = pytesseract.image_to_data(gray,lang=languages,config='--psm 6',
                    output_type=pytesseract.Output.DICT,timeout=20)
        lines_by_id = {}
        confidences = []
        for i, (word, confidence) in enumerate(zip(data['text'], data['conf'])):
            if not word.strip():
                continue
            key = (data['page_num'][i], data['block_num'][i],
                   data['par_num'][i], data['line_num'][i])
            lines_by_id.setdefault(key, []).append(word.strip())
            if float(confidence) >= 0:
                confidences.append(float(confidence))
        # Keep the visual OCR lines intact: separate token-per-line output
        # lost important relationships such as 'CIN: AB1234567'.
        text_lines = '\n'.join(' '.join(words) for words in lines_by_id.values())
        fields = proposed_fields(text_lines, kind)
        if kind == 'passport':
            mrz_lines = pytesseract.image_to_string(gray, lang='eng',
                                                     config='--psm 6', timeout=20)
            fields.update(proposed_fields(mrz_lines, kind))
        # Escalation is intentionally lazy. Clear, labelled high-quality proposals
        # avoid the extra OCR call. Ambiguous/empty/low-quality pages get sparse OCR.
        # An alternate result is advisory; a disagreement never silently overwrites.
        enhanced = False
        if (not fields or any(value['confidence'] < .65 for value in fields.values())
                or (confidences and sum(confidences)/len(confidences) < 62) or warnings):
            enhanced = True
            sparse_lines = pytesseract.image_to_string(
                gray, lang=languages, config='--psm 11', timeout=20)
            secondary = proposed_fields(sparse_lines, kind)
            for key, value in secondary.items():
                if key not in fields:
                    fields[key] = value
                elif fields[key]['value'] != value['value'] and 'ocr_disagreement' not in warnings:
                    warnings.append('ocr_disagreement')
        return {'engine':'tesseract-local','kind':kind,'requiresHumanReview':True,
                'enhanced':enhanced,'fields':fields,'visualHash':fingerprint,
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
