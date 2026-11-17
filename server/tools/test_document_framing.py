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


if __name__ == '__main__':
    unittest.main()
