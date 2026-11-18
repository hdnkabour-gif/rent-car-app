"""#15 — four-corner detection, perspective correction and card-region quality, on synthetic images only.
Needs the pinned OpenCV/numpy (requirements-ocr.txt); skipped where they are not installed."""
import unittest

try:
    import cv2
    import numpy as np
    HAVE_CV = True
except ImportError:  # pragma: no cover - CI installs them for this step
    HAVE_CV = False

import document_ocr as d


def synthetic_card(w=856, h=540, seed=1):
    """A light card with dark 'text' strokes (no real document)."""
    rng = np.random.default_rng(seed)
    card = np.full((h, w, 3), 235, np.uint8)
    for row in range(60, h - 40, 36):
        x = 40
        while x < w - 80:
            ww = int(rng.integers(12, 60))
            cv2.rectangle(card, (x, row), (x + ww, row + 14), (25, 25, 25), -1)
            x += ww + int(rng.integers(6, 18))
    return card


def photograph(card, corners, size=(1600, 1200), background=35, smooth=False):
    """Places the card in perspective on a dark background (noisy, or smooth like an out-of-focus table)."""
    h, w = card.shape[:2]
    src = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype='float32')
    m = cv2.getPerspectiveTransform(src, np.array(corners, dtype='float32'))
    bg = np.random.default_rng(7).integers(background - 8, background + 8, (size[1], size[0], 3)).astype(np.uint8)
    if smooth:
        bg = cv2.GaussianBlur(bg, (0, 0), 6)
    warped = cv2.warpPerspective(card, m, size)
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), m, size)
    bg[mask > 0] = warped[mask > 0]
    return bg


@unittest.skipUnless(HAVE_CV, 'OpenCV not installed')
class FramingTest(unittest.TestCase):
    CORNERS = [[310, 240], [1290, 300], [1250, 930], [270, 850]]  # a tilted, keystoned card

    def test_finds_the_four_corners_of_a_tilted_card(self):
        photo = photograph(synthetic_card(), self.CORNERS)
        quad, area = d.find_document_quad(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY))
        self.assertIsNotNone(quad)
        for found, expected in zip(quad, self.CORNERS):
            self.assertLess(np.linalg.norm(found - np.array(expected)), 0.02 * 2000, (found, expected))
        self.assertGreater(area, 0.25)

    def test_perspective_is_corrected_to_the_id1_aspect(self):
        photo = photograph(synthetic_card(), self.CORNERS)
        quad, _ = d.find_document_quad(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY))
        card = d.warp_document(photo, quad, 'id_front')
        h, w = card.shape[:2]
        self.assertAlmostEqual(w / h, 85.6 / 54.0, delta=0.02)
        # The corrected card is light with dark strokes, like the original (no background left in it).
        self.assertGreater(float(cv2.cvtColor(card, cv2.COLOR_BGR2GRAY).mean()), 150)

    def test_no_outline_means_retake_guidance_not_a_guess(self):
        noise = np.random.default_rng(3).integers(0, 255, (900, 1200), dtype=np.uint8)
        quad, area = d.find_document_quad(cv2.GaussianBlur(noise, (9, 9), 0))
        self.assertIsNone(quad)
        self.assertEqual(d.frame_warnings(False, 0.0, from_pdf=False), ['no_document_edges'])
        self.assertEqual(d.frame_warnings(False, 0.0, from_pdf=True), [])  # a scanned page has no outline

    def test_a_small_card_far_away_asks_to_come_closer(self):
        small = [[560, 440], [1040, 448], [1036, 750], [564, 742]]  # ~8% of the photo
        photo = photograph(synthetic_card(), small)
        quad, area = d.find_document_quad(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY))
        self.assertIsNotNone(quad)
        self.assertIn('document_too_small', d.frame_warnings(True, area, from_pdf=False))

    def test_quality_is_measured_on_the_card_not_the_background(self):
        """Same sharp card, small on a dark background. The whole photo reads 'too dark' (a false alarm) and its
        blur score changes with the background; measured on the corrected card, neither happens.
        (Whether this removes the production blur warnings must still be checked on consented real photos.)"""
        corners = [[560, 440], [1040, 448], [1036, 750], [564, 742]]
        scores = []
        for background, smooth in ((20, True), (35, False)):
            photo = photograph(synthetic_card(), corners, background=background, smooth=smooth)
            gray = cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY)
            self.assertLess(float(gray.mean()), 55)  # old whole-photo check: 'too_dark'
            quad, _ = d.find_document_quad(gray)
            card = d.card_quality(cv2.cvtColor(d.warp_document(photo, quad, 'id_front'), cv2.COLOR_BGR2GRAY))
            self.assertGreater(card['brightness'], 150)
            self.assertGreater(card['blurVariance'], 65)
            scores.append((float(cv2.Laplacian(gray, cv2.CV_64F).var()), card['blurVariance']))
        (old_a, new_a), (old_b, new_b) = scores
        self.assertGreater(abs(old_a - old_b) / max(old_a, old_b), 0.2)   # old score moved with the background
        self.assertLess(abs(new_a - new_b) / max(new_a, new_b), 0.02)    # new score does not

    def test_a_really_blurred_card_is_still_reported(self):
        blurred = cv2.GaussianBlur(synthetic_card(), (31, 31), 12)
        q = d.card_quality(cv2.cvtColor(blurred, cv2.COLOR_BGR2GRAY))
        self.assertLess(q['blurVariance'], 65)


@unittest.skipUnless(HAVE_CV, 'OpenCV not installed')
class GateFixesTest(unittest.TestCase):
    """Integration gate on PR #25 (B25-1, B25-2)."""

    def test_b25_1_high_resolution_card_keeps_its_proportions(self):
        big = np.zeros((3000, 4500, 3), np.uint8)
        for quad, landscape in (([[100, 100], [4100, 120], [4090, 2640], [110, 2620]], True),
                                ([[200, 100], [2720, 110], [2700, 4100], [210, 4090]], False)):
            out = d.warp_document(big, np.array(quad, dtype='float32'), 'id_front')
            h, w = out.shape[:2]
            self.assertLessEqual(max(w, h), 2400)
            ratio = w / h if landscape else h / w
            self.assertAlmostEqual(ratio, 85.6 / 54.0, delta=0.02, msg=(w, h))  # was 2400x2400 before

    def test_b25_2_already_cropped_card_with_an_inner_photo_is_not_cropped(self):
        card = synthetic_card(1712, 1080)
        cv2.rectangle(card, (60, 160), (520, 760), (90, 90, 90), 6)  # inner "photo" frame, >3% of the card
        quad, area, region = d.choose_document_region(cv2.cvtColor(card, cv2.COLOR_BGR2GRAY), 'id_back', False)
        self.assertIsNone(quad)
        self.assertEqual(region, 'already_cropped')

    def test_b25_2_pdf_pages_are_never_cropped(self):
        page = np.full((1754, 1240, 3), 250, np.uint8)
        cv2.rectangle(page, (100, 400), (1140, 1100), (30, 30, 30), 4)  # a table on the page
        quad, _, region = d.choose_document_region(cv2.cvtColor(page, cv2.COLOR_BGR2GRAY), 'insurance', True)
        self.assertIsNone(quad)
        self.assertEqual(region, 'pdf_page_kept_whole')

    def test_b25_2_an_inner_rectangle_with_wrong_proportions_is_rejected(self):
        # Photo of a page with no visible outer border but a square-ish table inside it.
        photo = np.full((1200, 1600, 3), 245, np.uint8)
        cv2.rectangle(photo, (500, 300), (1100, 900), (20, 20, 20), 5)
        quad, area, region = d.choose_document_region(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY), 'id_front', False)
        self.assertIsNone(quad)
        self.assertEqual(region, 'outline_wrong_proportions')

    def test_b25_2_a_real_card_in_a_photo_is_still_corrected(self):
        photo = photograph(synthetic_card(), FramingTest.CORNERS)
        quad, _, region = d.choose_document_region(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY), 'id_front', False)
        self.assertIsNotNone(quad)
        self.assertEqual(region, 'outline')


if __name__ == '__main__':
    unittest.main()
