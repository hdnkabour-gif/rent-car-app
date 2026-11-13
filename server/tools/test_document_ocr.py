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

    def test_unlabelled_serial_must_not_be_mistaken_for_identity(self):
        self.assertEqual(proposed_fields('PEUGEOT\nPS1002\nTECHNIQUE', 'id_front'), {})
        self.assertEqual(proposed_fields('PS1002', 'id_back'), {})

    def test_labelled_identity_number_with_preserved_line_spacing(self):
        self.assertEqual(
            proposed_fields('CARTE NATIONALE\nCIN: PS1002', 'id_front')
            ['documentNumber']['value'], 'PS1002'
        )
        self.assertEqual(
            proposed_fields('CIN:\nAB1234567', 'id_front')
            ['documentNumber']['value'], 'AB1234567'
        )

    def test_normalizes_arabic_and_persian_numerals_in_labelled_cin(self):
        self.assertEqual(
            proposed_fields('CIN: AB١٢٣٤٥٦٧', 'id_front')
            ['documentNumber']['value'], 'AB1234567'
        )
        self.assertEqual(
            proposed_fields('CIN: AB۱۲۳۴۵۶۷', 'id_front')
            ['documentNumber']['value'], 'AB1234567'
        )

    def test_not_promoting_license_or_other_text_to_cin(self):
        self.assertEqual(proposed_fields('CIN: AB1234567', 'licence_front'), {})
        self.assertEqual(proposed_fields('MAROC AB1234567', 'id_front'), {})

    def test_vehicle_registration_ocr_only_labelled_fields(self):
        self.assertEqual(proposed_fields('UNLABELLED VF1ABC12345678901', 'registration'), {})
        fields = proposed_fields(
            'Immatriculation: 12345-أ-6\\nN° du châssis: VF1ABC12345678901', 'registration')
        self.assertEqual(fields['plateNumber']['value'], '12345-أ-6')
        self.assertEqual(fields['vin']['value'], 'VF1ABC12345678901')
        self.assertLess(fields['vin']['confidence'], .5)

    def test_insurance_and_signed_contract_do_not_infer_unlabelled_numbers(self):
        insurance = proposed_fields('N° police: POL-2026\\nImmatriculation: 12345-أ-6','insurance')
        self.assertEqual(insurance['policyNumber']['value'], 'POL-2026')
        self.assertEqual(insurance['plateNumber']['value'], '12345-أ-6')
        contract = proposed_fields('Contrat N°: C-00015\\nImmatriculation: 12345-أ-6','contract_signed')
        self.assertEqual(contract['contractNumber']['value'], 'C-00015')
        self.assertEqual(proposed_fields('C-00015', 'contract_signed'), {})

    def test_visual_hash_distance(self):
        self.assertEqual(hamming_distance('0000000000000000','ffffffffffffffff'),64)
        self.assertEqual(hamming_distance('0000000000000000','0000000000000001'),1)
        with self.assertRaises(ValueError):
            hamming_distance('invalid','0000000000000000')

if __name__ == '__main__':
    unittest.main()
