import unittest
from document_ocr import hamming_distance, mrz_check, proposed_fields

class DocumentOcrParserTests(unittest.TestCase):
    def test_valid_passport_mrz_checksum(self):
        first = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'
        second = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'
        self.assertEqual(len(first), 44)
        self.assertEqual(len(second), 44)
        suggestions = proposed_fields(first + '\n' + second, 'passport')
        self.assertEqual(suggestions['documentNumber']['value'], 'L898902C3')
        self.assertEqual(suggestions['birthDateYYMMDD']['value'], '740812')
        self.assertEqual(suggestions['fullName']['value'], 'ANNA MARIA ERIKSSON')
        self.assertTrue(mrz_check(second[:9], second[9]))

    def test_rejects_invalid_passport_checksum(self):
        first = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'
        second = 'L898902C30UTO7408122F1204159ZE184226B<<<<<10'
        self.assertEqual(proposed_fields(first + '\n' + second, 'passport'), {})

    def test_cin_is_only_an_unverified_hint(self):
        hint = proposed_fields('MAROC CIN AB1234567', 'id_front')['documentNumber']
        self.assertEqual(hint['value'], 'AB1234567')
        self.assertLess(hint['confidence'], .5)

    def test_visual_hash_distance(self):
        self.assertEqual(hamming_distance('0000000000000000','ffffffffffffffff'),64)
        self.assertEqual(hamming_distance('0000000000000000','0000000000000001'),1)
        with self.assertRaises(ValueError):
            hamming_distance('invalid','0000000000000000')

if __name__ == '__main__':
    unittest.main()
