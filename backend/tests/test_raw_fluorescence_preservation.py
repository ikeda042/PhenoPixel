from __future__ import annotations

import pickle
import unittest

import cv2
import numpy as np

from app.bulk_engine.crud import _get_points_inside_cell
from app.cellextraction.crud import SyncChores


def _encode_png(image: np.ndarray) -> bytes:
    success, buffer = cv2.imencode(".png", image)
    if not success:
        raise AssertionError("Failed to encode test image")
    return buffer.tobytes()


class RawFluorescencePreservationTest(unittest.TestCase):
    def test_fluorescence_preparation_preserves_uint16_values(self):
        raw = np.array(
            [
                [10, 300],
                [1024, 4096],
            ],
            dtype=np.uint16,
        )

        prepared = SyncChores.preserve_raw_fluorescence_image(raw, "Fluo1")
        encoded = _encode_png(prepared)
        decoded = cv2.imdecode(np.frombuffer(encoded, np.uint8), cv2.IMREAD_UNCHANGED)

        self.assertEqual(prepared.dtype, np.uint16)
        self.assertEqual(decoded.dtype, np.uint16)
        self.assertEqual(int(decoded.max()), 4096)

    def test_float_fluorescence_preparation_keeps_count_values(self):
        raw = np.array(
            [
                [10.0, 300.0],
                [1024.0, 4096.0],
            ],
            dtype=np.float64,
        )

        prepared = SyncChores.preserve_raw_fluorescence_image(raw, "Fluo1")
        encoded = _encode_png(prepared)
        decoded = cv2.imdecode(np.frombuffer(encoded, np.uint8), cv2.IMREAD_UNCHANGED)

        self.assertEqual(prepared.dtype, np.uint16)
        self.assertEqual(decoded.dtype, np.uint16)
        self.assertEqual(int(decoded.max()), 4096)

    def test_ph_processing_still_normalizes_to_uint8(self):
        ph = np.array(
            [
                [100, 200],
                [300, 500],
            ],
            dtype=np.uint16,
        )

        processed = SyncChores.process_image(ph)

        self.assertEqual(processed.dtype, np.uint8)
        self.assertEqual(int(processed.min()), 0)
        self.assertEqual(int(processed.max()), 255)

    def test_raw_intensity_points_keep_values_above_255(self):
        raw = np.zeros((5, 5), dtype=np.uint16)
        raw[1:4, 1:4] = np.arange(1000, 1009, dtype=np.uint16).reshape(3, 3)
        contour = np.array([[[1, 1]], [[3, 1]], [[3, 3]], [[1, 3]]], dtype=np.int32)

        points = _get_points_inside_cell(_encode_png(raw), pickle.dumps(contour))

        self.assertGreater(int(points.max()), 255)
        self.assertEqual(int(points.max()), 1008)


if __name__ == "__main__":
    unittest.main()
