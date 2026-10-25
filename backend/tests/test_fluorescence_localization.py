from __future__ import annotations

import pickle
import unittest

import cv2
import numpy as np

from app.bulk_engine.fluorescence_localization import calculate_localization_metrics


def encode(image: np.ndarray) -> bytes:
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


class FluorescenceLocalizationTest(unittest.TestCase):
    def setUp(self):
        self.contour = np.array([[[4, 6]], [[44, 6]], [[44, 14]], [[4, 14]]], dtype=np.int32)
        self.contour_blob = pickle.dumps(self.contour)
        self.image = np.full((24, 50), 100, dtype=np.uint16)

    def measure(self, image, **kwargs):
        return calculate_localization_metrics(encode(image), self.contour_blob, **kwargs)

    def test_uniform_signal_is_diffuse_and_has_no_regional_enrichment(self):
        self.image[6:15, 4:45] = 600
        values = self.measure(self.image)
        self.assertAlmostEqual(values["entropy_norm"], 1)
        self.assertAlmostEqual(values["hoyer_sparsity"], 0)
        self.assertAlmostEqual(values["top10_fraction"], 37 / 369)
        self.assertAlmostEqual(values["polar_enrichment"], 1)
        self.assertAlmostEqual(values["midcell_enrichment"], 1)
        self.assertAlmostEqual(values["axial_offset"], 0)
        self.assertAlmostEqual(values["axial_asymmetry"], 0)
        self.assertAlmostEqual(values["background_intensity"], 100)

    def test_polar_midcell_and_bipolar_spots_have_distinct_positions(self):
        pole = self.image.copy()
        pole[10, 8] = 1100
        midcell = self.image.copy()
        midcell[10, 24] = 1100
        bipolar = self.image.copy()
        bipolar[10, [8, 40]] = 1100
        p, m, b = (self.measure(image) for image in (pole, midcell, bipolar))
        for spot in (p, m):
            self.assertAlmostEqual(spot["entropy_norm"], 0)
            self.assertAlmostEqual(spot["hoyer_sparsity"], 1)
            self.assertAlmostEqual(spot["top10_fraction"], 1)
            self.assertAlmostEqual(spot["axial_spread"], 0)
        self.assertGreater(p["polar_enrichment"], 1)
        self.assertEqual(p["midcell_enrichment"], 0)
        self.assertAlmostEqual(p["axial_offset"], 0.8)
        self.assertAlmostEqual(p["axial_asymmetry"], 1)
        self.assertGreater(m["midcell_enrichment"], 1)
        self.assertEqual(m["polar_enrichment"], 0)
        self.assertAlmostEqual(m["axial_offset"], 0)
        self.assertAlmostEqual(m["axial_asymmetry"], 0)
        self.assertAlmostEqual(b["polar_enrichment"], p["polar_enrichment"])
        self.assertAlmostEqual(b["axial_spread"], 0.4)
        self.assertAlmostEqual(b["axial_offset"], 0)
        self.assertAlmostEqual(b["axial_asymmetry"], 0)

    def test_background_offset_and_intensity_scale_do_not_change_corrected_descriptors(self):
        self.image[10, 8] = 1100
        expected = self.measure(self.image)
        scaled = self.measure(self.image * 10)
        shifted = self.measure(self.image + 500)
        for key in expected:
            if key != "background_intensity":
                self.assertAlmostEqual(scaled[key], expected[key])
                self.assertAlmostEqual(shifted[key], expected[key])
        raw = self.measure(self.image, background_mode="none")
        self.assertEqual(raw["background_intensity"], 0)
        self.assertGreater(raw["entropy_norm"], expected["entropy_norm"])

    def test_rotation_and_reflection_preserve_unsigned_descriptors(self):
        self.image[10, 8] = 1100
        self.image[10, 40] = 500
        expected = self.measure(self.image)
        reflected_contour = self.contour.copy()
        reflected_contour[:, :, 0] = self.image.shape[1] - 1 - reflected_contour[:, :, 0]
        rotated_contour = self.contour[:, :, ::-1].copy()
        rotated_contour[:, :, 1] = self.image.shape[1] - 1 - self.contour[:, :, 0]
        for image, contour in ((self.image[:, ::-1], reflected_contour), (np.rot90(self.image), rotated_contour)):
            values = calculate_localization_metrics(encode(image), pickle.dumps(contour))
            for key in expected:
                self.assertAlmostEqual(values[key], expected[key], places=6, msg=key)

    def test_no_signal_and_unavailable_background_are_missing(self):
        values = self.measure(self.image)
        self.assertEqual(values.pop("background_intensity"), 100)
        self.assertTrue(all(value is None for value in values.values()))
        full_contour = pickle.dumps(np.array([[[0, 0]], [[49, 0]], [[49, 23]], [[0, 23]]], dtype=np.int32))
        full = calculate_localization_metrics(encode(self.image), full_contour)
        self.assertTrue(all(value is None for value in full.values()))
        raw = calculate_localization_metrics(encode(self.image), full_contour, background_mode="none")
        self.assertAlmostEqual(raw["entropy_norm"], 1)


if __name__ == "__main__":
    unittest.main()
