"""Gate round 2 on #25: whenever the photo is cropped, the WHOLE image is read too, so nothing outside the crop
is lost even when everything read inside the crop is highly confident. The OCR engine is replaced by a fake
(no Tesseract needed, no real document): the crop yields one confident field, the whole image yields one more."""
import sys
import tempfile
import types
import unittest
from pathlib import Path

try:
    import cv2
    HAVE_CV = True
except ImportError:  # pragma: no cover
    HAVE_CV = False

import document_ocr as d


class FakeTesseract(types.ModuleType):
    """Returns 'CROP' for the corrected card and 'FULL' for the original photo (told apart by width)."""
    class Output:
        DICT = 'dict'

    def __init__(self, full_width):
        super().__init__('pytesseract')
        self.full_width = full_width
        self.calls = []

    def _label(self, image):
        return 'FULL' if image.shape[1] == self.full_width else 'CROP'

    def image_to_data(self, image, **_):
        label = self._label(image)
        self.calls.append(('data', label))
        return {'text': [label], 'conf': [95], 'page_num': [1], 'block_num': [1], 'par_num': [1], 'line_num': [1]}

    def image_to_string(self, image, **_):
        label = self._label(image)
        self.calls.append(('string', label))
        return label


def fake_fields(text, kind):
    if 'FULL' in text:
        return {'documentNumber': {'value': 'D23145890', 'confidence': .95, 'basis': 'fake'},
                'expiryDate': {'value': '2031-01-01', 'confidence': .9, 'basis': 'fake'}}
    if 'CROP' in text:
        return {'documentNumber': {'value': 'D23145890', 'confidence': .95, 'basis': 'fake'}}
    return {}


@unittest.skipUnless(HAVE_CV, 'OpenCV not installed')
class FullImageAlwaysReadTest(unittest.TestCase):
    def test_confident_crop_still_reads_the_whole_image(self):
        from test_document_framing import FramingTest, photograph, synthetic_card
        photo = photograph(synthetic_card(), FramingTest.CORNERS)  # 1600 px wide, card in perspective
        fake = FakeTesseract(full_width=photo.shape[1])
        saved_module, saved_fields = sys.modules.get('pytesseract'), d.proposed_fields
        sys.modules['pytesseract'] = fake
        d.proposed_fields = fake_fields
        try:
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / 'photo.png'
                cv2.imwrite(str(p), photo)
                result = d.ocr_document(str(p), 'id_front')
        finally:
            d.proposed_fields = saved_fields
            if saved_module is None:
                sys.modules.pop('pytesseract', None)
            else:
                sys.modules['pytesseract'] = saved_module
        self.assertTrue(result['frame']['corrected'])                 # the photo was cropped…
        self.assertIn(('string', 'FULL'), fake.calls)                 # …and the whole image was read anyway
        self.assertTrue(result['frame'].get('fullImageFallback'))
        self.assertIn('expiryDate', result['fields'])                 # the field outside the crop survives
        self.assertTrue(result['requiresHumanReview'])                # still only suggestions


if __name__ == '__main__':
    unittest.main()
