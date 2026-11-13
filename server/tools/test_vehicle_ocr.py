import unittest
from vehicle_ocr import normalize_digits, extract_plate_candidates, extract_odometer_candidates

class VehicleImageParserTests(unittest.TestCase):
    def test_arabic_and_persian_numerals(self):
        self.assertEqual(normalize_digits("١٢٣٤٥٠ ۱۲۳۴۵"),"123450 12345")

    def test_plate_components_are_suggestions_not_a_certain_plate(self):
        result = extract_plate_candidates("١٢٣٤٥ | أ | ٦")
        self.assertTrue(result["requiresHumanReview"])
        self.assertEqual(result["fields"]["numberBlocks"]["value"],"12345 / 6")
        self.assertIn("أ",result["fields"]["arabicLetters"]["value"])
        self.assertLess(result["fields"]["numberBlocks"]["confidence"], .5)

    def test_odometer_captions_and_ambiguous_trip_values(self):
        text = "ODO ١٢٣ ٤٥٦ KM  TRIP ٥٦٧"
        result = extract_odometer_candidates(text)
        self.assertTrue(result["requiresHumanReview"])
        values = [item["value"] for item in result["candidates"]]
        self.assertIn(123456, values)
        self.assertIn(567, values)
        self.assertEqual(result["kind"],"vehicle_odometer")

    def test_false_or_absent_values_are_not_invented(self):
        self.assertEqual(extract_odometer_candidates("car is ready")["candidates"], [])
        self.assertEqual(extract_plate_candidates("no plate is visible")["fields"], {})

if __name__ == "__main__":
    unittest.main()
