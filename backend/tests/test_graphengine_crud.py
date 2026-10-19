from __future__ import annotations

import unittest

import numpy as np

from app.bulk_engine.heatmap_bulk_core import build_heatmap_vectors_csv
from app.graphengine.crud import DEFAULT_MODE, GraphEngineCrud


def _export_cells(
    cells: list[tuple[list[float], list[float]]], pixel_size_um: float = 0.1
) -> str:
    return build_heatmap_vectors_csv(
        [list(zip(u1, peaks)) for u1, peaks in cells],
        pixel_size_um=pixel_size_um,
    ).decode("utf-8")


class GraphEngineCrudTest(unittest.TestCase):
    def test_bulk_exports_accept_35_36_and_variable_point_counts(self):
        cells = [
            ([float(i) for i in range(count)], [float(i % 7) for i in range(count)])
            for count in (35, 36, 7)
        ]
        text = _export_cells(cells, pixel_size_um=0.108)

        parsed = GraphEngineCrud._parse_heatmap_cells(text)
        mean_length, nagg_rate = GraphEngineCrud._analyze_csv(text, ctrl=None)

        self.assertEqual([len(u1) for u1, _ in parsed], [35, 36, 7])
        self.assertAlmostEqual(mean_length, (3.67 + 3.78 + 0.65) / 3)
        self.assertIsNone(nagg_rate)

    def test_control_threshold_uses_only_fluorescence_rows(self):
        peaks = [0.0, 1.0, 1.0, 1.0, 1.0]
        first = _export_cells([([0.0, 1.0, 2.0, 3.0, 4.0], peaks)])
        shifted = _export_cells([([100.0, 100.0, 100.0, 100.0, 101.0], peaks)])

        self.assertAlmostEqual(GraphEngineCrud._parse_ctrl(first), 0.8)
        self.assertAlmostEqual(GraphEngineCrud._parse_ctrl(shifted), 0.8)

    def test_control_preserves_descending_95_percent_index_rule(self):
        cells = [([0.0, 1.0, 2.0], [0.0, i / 20, 1.0]) for i in range(21)]

        threshold = GraphEngineCrud._parse_ctrl(_export_cells(cells))

        self.assertAlmostEqual(threshold, 0.35)

    def test_nagg_compares_the_same_cell_score_strictly_below_control(self):
        u1 = [0.0, 1.0, 2.0, 3.0, 4.0]
        control = _export_cells([(u1, [0.0, 1.0, 1.0, 1.0, 1.0])])
        treated = _export_cells([
            (u1, [0.0, 0.0, 1.0, 1.0, 1.0]),
            (u1, [0.0, 1.0, 1.0, 1.0, 1.0]),
        ])

        mean_length, nagg_rate = GraphEngineCrud._analyze_csv(
            treated, GraphEngineCrud._parse_ctrl(control)
        )

        self.assertAlmostEqual(mean_length, 0.4)
        self.assertEqual(nagg_rate, 0.5)

    def test_valid_cells_can_have_a_real_zero_nagg_rate(self):
        text = _export_cells([([0.0, 1.0, 2.0], [0.0, 1.0, 1.0])])

        mean_length, nagg_rate = GraphEngineCrud._analyze_csv(
            text, GraphEngineCrud._parse_ctrl(text)
        )

        self.assertGreater(mean_length, 0)
        self.assertEqual(nagg_rate, 0.0)

    def test_constant_profiles_keep_the_existing_score(self):
        text = _export_cells([([0.0, 1.0, 2.0], [7.0, 7.0, 7.0])])

        self.assertEqual(GraphEngineCrud._parse_ctrl(text), 7.0)

    def test_bom_comments_whitespace_and_trailing_padding_are_accepted(self):
        text = "\ufeff# pixel_size_um=0.1\n\n0, 1, 2, ,\n10, 20, 30, ,\n"

        mean_length, _ = GraphEngineCrud._analyze_csv(text, ctrl=None)

        self.assertAlmostEqual(mean_length, 0.2)
        self.assertAlmostEqual(GraphEngineCrud._parse_ctrl(text), 0.5)

    def test_invalid_or_empty_cells_raise_instead_of_returning_zero(self):
        cases = {
            "empty": "",
            "metadata_only": "# pixel_size_um=0.1\n",
            "unpaired": "0,1,2\n",
            "one_point": "0\n1\n",
            "mismatched": "0,1,2\n1,2\n",
            "non_numeric": "0,1,2\n1,bad,3\n",
            "non_finite_position": "0,nan,2\n1,2,3\n",
            "non_finite_fluorescence": "0,1,2\n1,2,inf\n",
            "interior_blank": "0,,2\n1,2,3\n",
            "unsorted_positions": "0,2,1\n1,2,3\n",
            "zero_span": "0,0,0\n1,2,3\n",
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    GraphEngineCrud._analyze_csv(text, ctrl=0.5)
                with self.assertRaises(ValueError):
                    GraphEngineCrud._parse_ctrl(text)

    def test_invalid_pairs_do_not_shift_the_remaining_cells(self):
        valid = _export_cells([([0.0, 1.0, 2.0], [10.0, 20.0, 30.0])])
        text = "0,1,2\n1,2\n" + valid

        parsed = GraphEngineCrud._parse_heatmap_cells(text)

        self.assertEqual(len(parsed), 1)
        np.testing.assert_array_equal(parsed[0][1], [10.0, 20.0, 30.0])

    def test_plots_use_only_fluorescence_for_every_vector_length(self):
        cells = [
            ([float(i) for i in range(count)], [100.0 + i for i in range(count)])
            for count in (36, 35)
        ]

        matrix = GraphEngineCrud._get_matrix_for_mode(DEFAULT_MODE, _export_cells(cells))

        self.assertEqual(matrix.shape, (2, 36))
        np.testing.assert_array_equal(matrix[0], cells[0][1])
        np.testing.assert_array_equal(matrix[1, :35], cells[1][1])
        self.assertTrue(np.isnan(matrix[1, 35]))

    def test_invalid_heatmap_does_not_fall_back_to_position_rows(self):
        with self.assertRaisesRegex(ValueError, "paired u1 and G"):
            GraphEngineCrud._get_matrix_for_mode(DEFAULT_MODE, "0,1,2\n")


if __name__ == "__main__":
    unittest.main()
