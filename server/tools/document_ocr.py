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

def mrz_date_iso(yymmdd: str, kind: str, today_yy: int | None = None) -> str | None:
    """ICAO dates carry no century: expiry dates are in 20xx; a birth year above this year is 19xx."""
    if not re.fullmatch(r'[0-9]{6}', yymmdd):
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:])
    if not (1 <= mm <= 12 and 1 <= dd <= 31):
        return None
    if today_yy is None:
        import datetime
        today_yy = datetime.date.today().year % 100
    century = 2000 if kind == 'expiry' or yy <= today_yy else 1900
    return f'{century + yy:04d}-{mm:02d}-{dd:02d}'


def fit_mrz_line(row: str, length: int, data_line: bool) -> str:
    """Repairs only what OCR typically breaks in MRZ FILLER, never data: a 'K' inside a '<' run becomes '<'
    (data lines only — the names line is left alone), extra trailing fillers are trimmed, missing ones padded.
    Every data field is still protected by its check digit afterwards."""
    if data_line:
        prev = None
        while prev != row:
            prev, row = row, re.sub(r'(?<=<)K(?=<)|(?<=<<)K$', '<', row)
    if len(row) > length and row[length:].strip('<') == '':
        row = row[:length]
    if length - 3 <= len(row) < length and row.endswith('<'):
        row = row + '<' * (length - len(row))
    return row


def extract_td1_mrz(text: str) -> dict:
    """ICAO 9303 TD1 (identity cards, 3 lines x 30). Fields are kept only when their check digit passes.
    Which national number a country stores in the optional data is NOT assumed: those stay unverified hints.
    """
    rows = [re.sub(r'[^A-Z0-9<]', '', line.upper()) for line in text.splitlines()]
    rows = [r for r in rows if r]
    for i in range(len(rows) - 2):
        l1, l2, l3 = fit_mrz_line(rows[i], 30, True), fit_mrz_line(rows[i + 1], 30, True), fit_mrz_line(rows[i + 2], 30, False)
        if len(l1) != 30 or len(l2) != 30 or len(l3) != 30 or l1[0] not in 'IAC':
            continue
        doc, doc_check, opt1 = l1[5:14], l1[14], l1[15:30]
        if doc_check == '<' and '<' in opt1:  # long document number continues in the optional data
            extra = opt1.split('<', 1)[0]
            doc, doc_check, opt1 = doc + extra[:-1], extra[-1:], opt1[len(extra):]
        if not mrz_check(doc, doc_check):
            continue
        composite = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]
        result = {'documentNumber': {'value': doc.replace('<', ''), 'confidence': .95, 'basis': 'mrz_td1_checksum'}}
        if l1[2:5].replace('<', ''):
            result['issuingState'] = {'value': l1[2:5].replace('<', ''), 'confidence': .8, 'basis': 'mrz_td1'}
        if mrz_check(l2[0:6], l2[6]):
            result['birthDate'] = {'value': mrz_date_iso(l2[0:6], 'birth') or l2[0:6], 'raw': l2[0:6], 'confidence': .9, 'basis': 'mrz_td1_checksum'}
        if l2[7] in 'MF':
            result['sex'] = {'value': l2[7], 'confidence': .8, 'basis': 'mrz_td1'}
        if mrz_check(l2[8:14], l2[14]):
            result['expiryDate'] = {'value': mrz_date_iso(l2[8:14], 'expiry') or l2[8:14], 'raw': l2[8:14], 'confidence': .9, 'basis': 'mrz_td1_checksum'}
        if l2[15:18].replace('<', ''):
            result['nationality'] = {'value': l2[15:18].replace('<', ''), 'confidence': .8, 'basis': 'mrz_td1'}
        optional = (opt1 + l2[18:29]).replace('<', ' ').split()
        if optional:
            result['optionalData'] = {'value': ' '.join(optional), 'confidence': .3, 'basis': 'mrz_td1_optional_unverified'}
        names = l3.split('<<', 1)
        surname = names[0].replace('<', ' ').strip()
        given = names[1].replace('<', ' ').strip() if len(names) > 1 else ''
        full = ' '.join(x for x in (given, surname) if x)
        if full:
            result['fullName'] = {'value': full, 'confidence': .7, 'basis': 'mrz_td1'}
        if not mrz_check(composite, l2[29]):
            # Individual checks passed but the whole line does not: keep the values, flag them as weaker.
            for value in result.values():
                value['confidence'] = min(value['confidence'], .5)
            result['_composite'] = {'value': 'failed', 'confidence': 0, 'basis': 'mrz_td1_composite'}
        return result
    return {}


def iso_date(value: str) -> str | None:
    """DD/MM/YYYY, DD.MM.YY or DD-MM-YYYY -> YYYY-MM-DD (a two-digit year is read as 20xx up to this year)."""
    m = re.fullmatch(r'([0-3]?[0-9])[./-]([01]?[0-9])[./-]((?:19|20)?[0-9]{2})', value.strip())
    if not m:
        return None
    d, mo, y = int(m[1]), int(m[2]), m[3]
    if len(y) == 2:
        import datetime
        yy = int(y)
        y = str(2000 + yy if yy <= datetime.date.today().year % 100 + 10 else 1900 + yy)
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f'{int(y):04d}-{mo:02d}-{d:02d}'


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
        # Moroccan driving licence (front/back): only values beside a known French/Arabic label.
        'licence_front': [
            # B25-3: the longest labels first (a bare 'N°' must not eat 'N° du permis'), and a plausible
            # number: at least four digits, so a word such as 'permis' can never be taken as the number.
            ('licenceNumber',
             r"n[°o.]\s*(?:du\s*)?permis(?:\s*de\s*conduire)?|permis\s*(?:de\s*conduire)?\s*n[°o.]|"
             r"\u0631\u0642\u0645\s*(?:\u0627\u0644)?\u0631\u062e\u0635\u0629(?:\s*\u0627\u0644\u0633\u064a\u0627\u0642\u0629)?",
             r'((?=(?:[A-Za-z/\-]*[0-9]){4})[A-Za-z0-9][A-Za-z0-9/\-]{3,19})'),
            ('issueDate', r"d[ée]livr[ée]\s*le|date\s*de\s*d[ée]livrance|\u062a\u0627\u0631\u064a\u062e\s*\u0627\u0644\u062a\u0633\u0644\u064a\u0645", date),
            ('expiryDate', r"valable\s*jusqu|fin\s*de\s*validit[ée]|\u0635\u0627\u0644\u062d\u0629\s*\u0625\u0644\u0649", date),
        ],
        'licence_back': [
            ('categories', r"cat[ée]gories?|\u0627\u0644\u0635\u0646\u0641", r'((?:\b(?:AM|A1|A2|A|B1|B|BE|C1|C|CE|D1|D|DE|EB|EC|ED)\b[\s,;/]*)+)'),
            ('expiryDate', r"valable\s*jusqu|fin\s*de\s*validit[ée]", date),
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
                if key.endswith('Date') and iso_date(found[1]):
                    out[key]['iso'] = iso_date(found[1])
                break
    return out

def proposed_fields(text: str, kind: str) -> dict:
    if kind == 'passport':
        return extract_passport_mrz(text)
    if kind in ('registration','insurance','technical_inspection','vignette',
                'transport_authorization','other_vehicle','contract_signed',
                'licence_front','licence_back'):
        return labelled_fields(text,kind)
    if kind in ('id_back', 'residence_permit'):
        td1 = extract_td1_mrz(text)
        if td1:
            return td1
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

# Expected width/height of the corrected document (landscape), by kind: ID-1 cards (CIN, licence, carte grise,
# ISO/IEC 7810: 85.6 x 54 mm), passport data page (TD3, 125 x 88 mm), A4 sheets (insurance, inspection...).
CARD = 85.6 / 54.0
ASPECT = {'id_front': CARD, 'id_back': CARD, 'licence_front': CARD, 'licence_back': CARD, 'residence_permit': CARD,
          'registration': CARD, 'passport': 125 / 88, 'insurance': 297 / 210, 'technical_inspection': 297 / 210,
          'vignette': 297 / 210, 'transport_authorization': 297 / 210, 'contract_signed': 297 / 210}
MIN_DOCUMENT_AREA = 0.03   # below this share of the photo, an outline is not trusted as the document
SMALL_DOCUMENT_AREA = 0.25  # below this, ask the person to come closer


def order_corners(points):
    """Top-left, top-right, bottom-right, bottom-left (image coordinates)."""
    import numpy as np
    pts = np.asarray(points, dtype='float32').reshape(4, 2)
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).reshape(4)
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype='float32')


def find_document_quad(gray):
    """Largest convex four-sided outline covering at least MIN_DOCUMENT_AREA of the photo, or (None, 0)."""
    import cv2
    import numpy as np
    h, w = gray.shape[:2]
    scale = 1000 / max(h, w) if max(h, w) > 1000 else 1.0
    small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale != 1.0 else gray
    edges = cv2.Canny(cv2.GaussianBlur(small, (5, 5), 0), 40, 140)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    total = float(small.shape[0] * small.shape[1])
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        area = cv2.contourArea(c) / total
        if area < MIN_DOCUMENT_AREA:
            break
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return order_corners(approx.reshape(4, 2) / scale), area
    return None, 0.0


def warp_document(img, quad, kind: str):
    """Perspective-corrects the document to the expected aspect for its kind (orientation kept as photographed)."""
    import cv2
    import numpy as np
    tl, tr, br, bl = quad
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    aspect = ASPECT.get(kind)
    if aspect:
        target = aspect if width >= height else 1 / aspect
        height = width / target
    # B25-1: one shared factor keeps the proportions computed above (no independent clamping).
    scale = min(1.0, 2400.0 / max(width, height))
    width, height = max(1, int(round(width * scale))), max(1, int(round(height * scale)))
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype='float32')
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(quad.astype('float32'), dst), (width, height),
                               flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def quad_aspect(quad) -> float:
    """Long side / short side of a detected outline."""
    import numpy as np
    tl, tr, br, bl = quad
    w = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    h = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    return max(w, h) / max(min(w, h), 1e-6)


def choose_document_region(gray, kind: str, from_pdf: bool):
    """B25-2: the outline is used to crop ONLY when it can be the document itself.
    Never for a PDF scan or an image that already has the document's proportions (an inner table, photo or
    panel must not replace the page), and only when its proportions match the expected document (+-15%).
    Returns (quad or None, area, reason)."""
    h, w = gray.shape[:2]
    if from_pdf:
        return None, 0.0, 'pdf_page_kept_whole'
    if looks_already_cropped(w, h, kind):
        return None, 0.0, 'already_cropped'
    quad, area = find_document_quad(gray)
    if quad is None:
        return None, 0.0, 'no_outline'
    aspect = ASPECT.get(kind)
    if aspect is None:
        return (quad, area, 'outline') if area >= SMALL_DOCUMENT_AREA else (None, area, 'outline_not_trusted')
    if abs(quad_aspect(quad) - aspect) / aspect > 0.15:
        return None, area, 'outline_wrong_proportions'
    return quad, area, 'outline'


def merge_full_image_fields(fields: dict, full_fields: dict, warnings: list) -> dict:
    """B25-2: fields read on the whole image complete those read on the cropped document. A value is replaced
    only by a more confident one (e.g. a checksum-verified MRZ value), and any disagreement is flagged."""
    out = dict(fields)
    for key, value in full_fields.items():
        if key not in out:
            out[key] = value
        elif out[key]['value'] != value['value']:
            if 'ocr_disagreement' not in warnings:
                warnings.append('ocr_disagreement')
            if value['confidence'] > out[key]['confidence']:
                out[key] = value
    return out


def card_quality(gray) -> dict:
    """Blur and brightness measured on the document itself at a normalised width (1000 px), so a dark
    background or a small card in a big photo no longer reads as 'blurry'."""
    import cv2
    h, w = gray.shape[:2]
    norm = cv2.resize(gray, (1000, max(1, int(h * 1000 / w))), interpolation=cv2.INTER_AREA if w > 1000 else cv2.INTER_CUBIC)
    return {'blurVariance': float(cv2.Laplacian(norm, cv2.CV_64F).var()), 'brightness': float(norm.mean()),
            'shortSidePx': int(min(h, w))}


def looks_already_cropped(width: int, height: int, kind: str) -> bool:
    """An image that already has the document's proportions (a scan or a cropped photo) needs no outline."""
    aspect = ASPECT.get(kind)
    if not aspect or not width or not height:
        return False
    ratio = width / height if width >= height else height / width
    return abs(ratio - aspect) / aspect < 0.08


def frame_warnings(detected: bool, area: float, from_pdf: bool, already_cropped: bool = False) -> list:
    """Retake guidance about the framing. A scanned PDF page or an already-cropped image has no outline to find."""
    if from_pdf or (not detected and already_cropped):
        return []
    if not detected:
        return ['no_document_edges']
    return ['document_too_small'] if area < SMALL_DOCUMENT_AREA else []


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
        # #15: find the document's four corners and correct the perspective before measuring or reading.
        from_pdf = path.suffix.lower() == '.pdf'
        full_gray = gray  # kept for the whole-image fallback (B25-2)
        quad, area, region = choose_document_region(gray, kind, from_pdf)
        frame = {'detected': quad is not None, 'areaRatio': round(area, 3), 'corrected': False,
                 'assumedCropped': region == 'already_cropped', 'region': region}
        if quad is not None:
            full_h, full_w = gray.shape
            frame['corners'] = [[round(float(x) / full_w, 4), round(float(y) / full_h, 4)] for x, y in quad]
            img = warp_document(img, quad, kind)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            frame['corrected'] = True
        height,width = gray.shape
        q = card_quality(gray)
        blur, brightness = q['blurVariance'], q['brightness']
        warnings = frame_warnings(quad is not None, area, from_pdf, frame['assumedCropped'])
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
        # B25-2: a crop must never cost information. When the cropped reading is empty or weak, read the
        # whole image too and merge (the crop is kept for quality, the page for completeness).
        if frame['corrected'] and (not fields or any(v['confidence'] < .65 for v in fields.values())):
            full_text = pytesseract.image_to_string(full_gray, lang=languages, config='--psm 6', timeout=20)
            fields = merge_full_image_fields(fields, proposed_fields(full_text, kind), warnings)
            frame['fullImageFallback'] = True
        if fields.pop('_composite', None) is not None:
            warnings.append('mrz_composite_failed')  # individual checks passed, the whole MRZ did not
        return {'engine':'tesseract-local','kind':kind,'requiresHumanReview':True,
                'enhanced':enhanced,'fields':fields,'visualHash':fingerprint,
                'frame':frame,
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
