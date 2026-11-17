"""#15 — TD1 MRZ, ISO dates and licence labels. Synthetic text only (the ICAO 9303 specimen person is fictitious)."""
import unittest
import document_ocr as d

SPECIMEN = 'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'


class Td1MrzTest(unittest.TestCase):
    def test_icao_specimen_every_check_digit(self):
        f = d.extract_td1_mrz(SPECIMEN)
        self.assertEqual(f['documentNumber']['value'], 'D23145890')
        self.assertEqual(f['documentNumber']['basis'], 'mrz_td1_checksum')
        self.assertEqual(f['birthDate']['value'], '1974-08-12')
        self.assertEqual(f['expiryDate']['value'], '2012-04-15')
        self.assertEqual(f['sex']['value'], 'F')
        self.assertEqual(f['fullName']['value'], 'ANNA MARIA ERIKSSON')
        self.assertNotIn('_composite', f)

    def test_ocr_noise_around_the_mrz_is_ignored(self):
        noisy = 'CARTE NATIONALE\n' + SPECIMEN.replace('\n', ' \n ') + '\nautre ligne'
        self.assertEqual(d.extract_td1_mrz(noisy)['documentNumber']['value'], 'D23145890')

    def test_a_misread_digit_rejects_the_document_number(self):
        self.assertEqual(d.extract_td1_mrz(SPECIMEN.replace('D23145890', 'D23145891')), {})

    def test_a_misread_birth_date_is_dropped_not_guessed(self):
        f = d.extract_td1_mrz(SPECIMEN.replace('7408122F', '7408132F'))
        self.assertNotIn('birthDate', f)
        self.assertEqual(f['_composite']['value'], 'failed')
        self.assertLessEqual(f['documentNumber']['confidence'], .5)

    def test_id_back_prefers_td1_and_id_front_never_reads_it(self):
        self.assertEqual(d.proposed_fields(SPECIMEN, 'id_back')['documentNumber']['basis'], 'mrz_td1_checksum')
        self.assertNotEqual(d.proposed_fields(SPECIMEN, 'id_front').get('documentNumber', {}).get('basis'), 'mrz_td1_checksum')

    def test_optional_data_stays_an_unverified_hint(self):
        line1 = 'I<UTOD231458907AB123456<<<<<<<'
        f = d.extract_td1_mrz(line1 + SPECIMEN[30:])
        self.assertEqual(f['optionalData']['basis'], 'mrz_td1_optional_unverified')
        self.assertLess(f['optionalData']['confidence'], .5)


class MrzOcrNoiseTest(unittest.TestCase):
    def test_tesseract_k_in_filler_is_repaired(self):
        # Exactly what Tesseract returned on a synthetic card (2026-11-17): a 'K' inside the filler, 32 chars.
        seen = 'I<UTOD231458907<<<<<<<<<<<<<<K<\n7408122F 1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<'
        self.assertEqual(d.extract_td1_mrz(seen)['documentNumber']['value'], 'D23145890')

    def test_names_line_is_never_rewritten(self):
        self.assertEqual(d.fit_mrz_line('ERIKSSON<<ANNA<K<MARIA<<<<<<<<', 30, False), 'ERIKSSON<<ANNA<K<MARIA<<<<<<<<')
        self.assertEqual(d.fit_mrz_line('AB<<K<<<', 8, True), 'AB<<<<<<')

    def test_a_k_inside_data_is_caught_by_the_check_digit(self):
        # 'K' replacing a digit of the document number is not filler: the check digit rejects the line.
        self.assertEqual(d.extract_td1_mrz(SPECIMEN.replace('D23145890', 'D2314K890')), {})


class FramingRulesTest(unittest.TestCase):
    def test_already_cropped_cards_get_no_framing_warning(self):
        self.assertTrue(d.looks_already_cropped(1712, 1080, 'id_back'))
        self.assertTrue(d.looks_already_cropped(1080, 1712, 'id_front'))   # portrait scan
        self.assertFalse(d.looks_already_cropped(1600, 1200, 'id_front'))  # a 4:3 photo with background
        self.assertEqual(d.frame_warnings(False, 0, False, already_cropped=True), [])
        self.assertEqual(d.frame_warnings(False, 0, False, already_cropped=False), ['no_document_edges'])


class GateLicenceAndMergeTest(unittest.TestCase):
    """Integration gate on PR #25 (B25-3, B25-2 merge)."""

    def test_b25_3_full_labels_are_matched_before_a_bare_number_sign(self):
        for text in ('N° du permis : 12/345678', 'N° permis : 12/345678', 'Permis de conduire N° 12/345678',
                     'رقم الرخصة : ١٢/٣٤٥٦٧٨', 'رقم رخصة السياقة: 12/345678'):
            f = d.proposed_fields(text, 'licence_front')
            self.assertEqual(f.get('licenceNumber', {}).get('value'), '12/345678', text)
            self.assertEqual(f['licenceNumber']['basis'], 'labelled_unverified')

    def test_b25_3_a_word_is_never_a_licence_number(self):
        self.assertNotIn('licenceNumber', d.proposed_fields('N° du permis : permis', 'licence_front'))
        self.assertNotIn('licenceNumber', d.proposed_fields('N° permis : ABC-DE', 'licence_front'))

    def test_b25_2_merge_completes_and_flags_disagreements(self):
        warnings = []
        cropped = {'documentNumber': {'value': 'D2314589', 'confidence': .45, 'basis': 'unverified_labelled_pattern'}}
        full = {'documentNumber': {'value': 'D23145890', 'confidence': .95, 'basis': 'mrz_td1_checksum'},
                'birthDate': {'value': '1974-08-12', 'confidence': .9, 'basis': 'mrz_td1_checksum'}}
        out = d.merge_full_image_fields(cropped, full, warnings)
        self.assertEqual(out['documentNumber']['value'], 'D23145890')   # the more confident, checksum-verified one
        self.assertIn('birthDate', out)                                 # information outside the crop is kept
        self.assertEqual(warnings, ['ocr_disagreement'])
        warnings2 = []
        out2 = d.merge_full_image_fields(full, {'documentNumber': {'value': 'X', 'confidence': .4, 'basis': 'x'}}, warnings2)
        self.assertEqual(out2['documentNumber']['value'], 'D23145890')  # a weaker value never replaces a stronger one
        self.assertEqual(warnings2, ['ocr_disagreement'])


class DatesTest(unittest.TestCase):
    def test_mrz_century_rules(self):
        self.assertEqual(d.mrz_date_iso('990101', 'birth', today_yy=26), '1999-01-01')
        self.assertEqual(d.mrz_date_iso('050101', 'birth', today_yy=26), '2005-01-01')
        self.assertEqual(d.mrz_date_iso('310101', 'expiry', today_yy=26), '2031-01-01')
        self.assertIsNone(d.mrz_date_iso('991399', 'birth', today_yy=26))

    def test_iso_date(self):
        self.assertEqual(d.iso_date('05/11/2026'), '2026-11-05')
        self.assertEqual(d.iso_date('5.1.2030'), '2030-01-05')
        self.assertIsNone(d.iso_date('31/13/2026'))


class LicenceLabelsTest(unittest.TestCase):
    def test_french_licence_front_labels_only(self):
        text = 'ROYAUME DU MAROC\nPermis de conduire N° 12/345678\nDélivré le 03/02/2020\nValable jusqu’au 02/02/2030'
        f = d.proposed_fields(text, 'licence_front')
        self.assertEqual(f['licenceNumber']['value'], '12/345678')
        self.assertEqual(f['issueDate']['iso'], '2020-02-03')
        self.assertEqual(f['expiryDate']['iso'], '2030-02-02')
        self.assertTrue(all(v['basis'] == 'labelled_unverified' and v['confidence'] < .5 for v in f.values()))

    def test_arabic_labels_and_numerals(self):
        text = 'رقم رخصة السياقة: ١٢/٣٤٥٦٧٨\nتاريخ التسليم ٠٣/٠٢/٢٠٢٠'
        f = d.proposed_fields(text, 'licence_front')
        self.assertEqual(f['licenceNumber']['value'], '12/345678')
        self.assertEqual(f['issueDate']['iso'], '2020-02-03')

    def test_unlabelled_numbers_are_not_licence_numbers(self):
        self.assertEqual(d.proposed_fields('B 12/345678 03/02/2020', 'licence_front'), {})

    def test_categories_on_the_back(self):
        self.assertEqual(d.proposed_fields('Catégories : B, C1', 'licence_back')['categories']['value'].replace(' ', ''), 'B,C1')


if __name__ == '__main__':
    unittest.main()
