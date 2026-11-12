from __future__ import annotations

import unittest
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.database_manager.spot_detection import analyze_spots, create_spot_plot, detect_spots
from app.database_manager.router import router_database_manager


class SpotFixture:
    def setUp(self):
        self.y, self.x = np.mgrid[:80, :100]
        self.mask = ((self.x - 50) / 45)**2 + ((self.y - 40) / 27)**2 < 1
        self.coordinates = np.column_stack(np.where(self.mask))
        self.points = self.coordinates[:, ::-1].astype(float)
        self.noise = np.random.default_rng(14).normal(0, 1, self.x.shape)
        self.background = 30 + 0.03 * self.x + self.noise
        self.centers = np.array([[28.4, 35.6], [68.2, 44.1]])
        self.image = self.background + self.gaussian(self.centers[0], 2, 80) + self.gaussian(self.centers[1], 2.5, 50)

    def gaussian(self, center, sigma, amplitude):
        return amplitude * np.exp(-((self.x - center[0])**2 + (self.y - center[1])**2) / (2 * sigma**2))

    def detect(self, image, **kwargs):
        return detect_spots(image, self.coordinates, self.points, **kwargs)[0]


class SpotDetectionTest(SpotFixture, unittest.TestCase):
    def test_recovers_centers_and_widths_with_unused_capacity(self):
        spots = self.detect(self.image, max_spots=5)
        self.assertEqual(len(spots), 2)
        np.testing.assert_allclose([spot.center for spot in spots], self.centers, atol=0.2)
        for spot, sigma in zip(spots, (2, 2.5)):
            np.testing.assert_allclose(np.sqrt(np.linalg.eigvalsh(spot.covariance)), sigma, atol=0.15)
            self.assertGreater(spot.snr, 4)
            self.assertGreater(spot.bic_improvement, 10)

    def test_uniform_noise_diffuse_lines_and_single_hot_pixels_are_not_spots(self):
        hot_pixel = self.background.copy()
        hot_pixel[40, 50] = 200
        images = [np.full(self.x.shape, 30.0), np.zeros(self.x.shape), self.background,
                  self.background + self.gaussian((50, 40), 13, 80),
                  self.background + 80 * np.exp(-0.5 * ((self.x - 50)**2 / 20**2 + (self.y - 40)**2 / 2**2)),
                  hot_pixel]
        for index, image in enumerate(images):
            with self.subTest(index=index):
                self.assertEqual(self.detect(image, max_spots=5), [])

    def test_count_is_a_cap_and_stricter_snr_can_return_zero(self):
        spots = self.detect(self.image, max_spots=1)
        self.assertEqual(len(spots), 1)
        np.testing.assert_allclose(spots[0].center, self.centers[0], atol=0.2)
        faint = self.background + self.gaussian((50, 40), 2, 8)
        self.assertEqual(len(self.detect(faint, min_snr=4)), 1)
        self.assertEqual(self.detect(faint, min_snr=15), [])

    def test_fits_are_invariant_to_linear_intensity_rescaling(self):
        first = self.detect(self.image)
        rescaled = self.detect(self.image * 100 + 500)
        self.assertEqual(len(first), len(rescaled))
        for left, right in zip(first, rescaled):
            np.testing.assert_allclose(left.center, right.center, atol=0.01)
            np.testing.assert_allclose(left.covariance, right.covariance, atol=0.01)
            self.assertAlmostEqual(right.amplitude / left.amplitude, 100, delta=0.1)

    def test_centers_and_covariances_follow_replot_rotation_without_axis_rescaling(self):
        rotation = np.array([[0.8, -0.6], [0.6, 0.8]])
        points = self.points @ rotation + [7, -9]
        spots, _, _ = detect_spots(self.image, self.coordinates, points)
        np.testing.assert_allclose([spot.center for spot in spots], self.centers @ rotation + [7, -9], atol=0.2)
        for spot, sigma in zip(spots, (2, 2.5)):
            np.testing.assert_allclose(np.linalg.eigvalsh(spot.covariance), sigma**2, atol=0.2)

    def test_spots_outside_the_cell_are_excluded(self):
        image = self.background + self.gaussian((4, 4), 2, 200)
        self.assertEqual(self.detect(image), [])

    def test_invalid_options_are_rejected(self):
        for options in ({'max_spots': 0}, {'max_spots': 17}, {'max_spots': 2.5},
                        {'sigma_min': 4, 'sigma_max': 2}, {'sigma_min': 0.1},
                        {'sigma_max': float('nan')}, {'min_snr': 1}, {'min_snr': 31}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.detect(self.image, **options)

    def test_plot_handles_detections_and_zero_spots(self):
        contour = np.array([[10, 20], [90, 20], [90, 60], [10, 60]])
        for image, dark_mode in ((self.image, True), (self.background, False)):
            output = create_spot_plot(image, self.coordinates, self.points, contour, dark_mode=dark_mode)
            decoded = cv2.imdecode(np.frombuffer(output, np.uint8), cv2.IMREAD_COLOR)
            self.assertIsNotNone(decoded)
            self.assertEqual(decoded.shape, (840, 840, 3))


class AutomaticSpotDetectionTest(SpotFixture, unittest.TestCase):
    def test_auto_recovers_different_widths_without_manual_settings(self):
        for sigma in (1.0, 2.5, 5.5, 9.0):
            with self.subTest(sigma=sigma):
                image = self.background + self.gaussian((50, 40), sigma, 80)
                spots = self.detect(image, auto_tune=True, sigma_min=4, sigma_max=1, min_snr=30)
                self.assertEqual(len(spots), 1)
                np.testing.assert_allclose(spots[0].center, (50, 40), atol=0.15)
                np.testing.assert_allclose(np.sqrt(np.linalg.eigvalsh(spots[0].covariance)), sigma, atol=0.15)

    def test_auto_rejects_noise_hot_pixels_diffuse_and_elongated_signals(self):
        hot_pixel = self.background.copy()
        hot_pixel[40, 50] = 200
        images = [np.zeros(self.x.shape), np.full(self.x.shape, 30.0), hot_pixel,
                  self.background + self.gaussian((50, 40), 12, 80),
                  self.background + 80 * np.exp(-0.5 * ((self.x - 50)**2 / 20**2 + (self.y - 40)**2 / 2**2))]
        images.extend(30 + np.random.default_rng(seed).normal(0, 1, self.x.shape) for seed in range(12))
        for index, image in enumerate(images):
            with self.subTest(index=index):
                self.assertEqual(self.detect(image, auto_tune=True, max_spots=5), [])

    def test_auto_cap_does_not_change_search_or_force_a_count(self):
        uncapped = analyze_spots(self.image, self.coordinates, self.points, max_spots=5, auto_tune=True)
        capped = analyze_spots(self.image, self.coordinates, self.points, max_spots=1, auto_tune=True)
        self.assertEqual(len(uncapped.spots), 2)
        self.assertEqual(len(capped.spots), 1)
        self.assertEqual(uncapped.settings, capped.settings)
        np.testing.assert_allclose(capped.spots[0].center, uncapped.spots[0].center, atol=1e-6)

    def test_auto_settings_follow_cell_geometry_and_noise_changes_absolute_cutoff(self):
        large = analyze_spots(self.background, self.coordinates, self.points, auto_tune=True)
        small_mask = ((self.x - 50) / 25)**2 + ((self.y - 40) / 8)**2 < 1
        coordinates = np.column_stack(np.where(small_mask))
        small = analyze_spots(self.background, coordinates, coordinates[:, ::-1], auto_tune=True)
        self.assertLess(small.settings.sigma_max, large.settings.sigma_max)
        self.assertLess(small.settings.min_snr, large.settings.min_snr)
        signal = self.gaussian((50, 40), 2, 8)
        self.assertEqual(len(self.detect(self.background + signal, auto_tune=True)), 1)
        self.assertEqual(self.detect(30 + self.noise * 4 + signal, auto_tune=True), [])

    def test_auto_is_reproducible_and_invariant_to_intensity_units(self):
        first = analyze_spots(self.image, self.coordinates, self.points, auto_tune=True)
        for image, multiplier in ((self.image, 1), (100 * self.image + 500, 100)):
            result = analyze_spots(image, self.coordinates, self.points, auto_tune=True)
            self.assertEqual(result.settings, first.settings)
            self.assertEqual(len(result.spots), len(first.spots))
            for left, right in zip(first.spots, result.spots):
                np.testing.assert_allclose(left.center, right.center, atol=0.01)
                np.testing.assert_allclose(left.covariance, right.covariance, atol=0.01)
                self.assertAlmostEqual(right.amplitude / left.amplitude, multiplier, delta=0.1)


class SpotEndpointTest(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router_database_manager, prefix='/api/v1')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def request(self, **params):
        return self.client.get('/api/v1/get-cell-e-means-spots',
                               params={'dbname': 'test.db', 'cell_id': 'F0C0', **params})

    def test_forwards_channel_width_snr_and_cap(self):
        with patch('app.database_manager.router.DatabaseManagerCrud.get_cell_e_means_spots',
                   return_value=b'png') as calculate:
            response = self.request(channel='fluo2', max_spots=5, sigma_min=0.8,
                                    sigma_max=3.5, min_snr=6, dark_mode=True)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['content-type'], 'image/png')
            calculate.assert_called_once_with('test.db', 'F0C0', channel='fluo2',
                max_spots=5, sigma_min=0.8, sigma_max=3.5, min_snr=6, dark_mode=True, auto_tune=False)

    def test_auto_can_be_requested_without_manual_parameters(self):
        with patch('app.database_manager.router.DatabaseManagerCrud.get_cell_e_means_spots',
                   return_value=b'png') as calculate:
            self.assertEqual(self.request(auto_tune=True).status_code, 200)
            self.assertTrue(calculate.call_args.kwargs['auto_tune'])

    def test_missing_images_and_invalid_requests_return_errors(self):
        for options in ({'channel': 'ph'}, {'max_spots': 17}, {'max_spots': 2.5},
                        {'sigma_min': 0.1}, {'sigma_max': 11}, {'min_snr': 31}):
            with self.subTest(options=options):
                self.assertEqual(self.request(**options).status_code, 422)
        for error, status in ((LookupError('fluo2 image not found'), 404),
                              (FileNotFoundError(), 404), (ValueError('Invalid widths'), 400)):
            with self.subTest(error=error), patch(
                'app.database_manager.router.DatabaseManagerCrud.get_cell_e_means_spots', side_effect=error,
            ):
                self.assertEqual(self.request().status_code, status)


if __name__ == '__main__':
    unittest.main()
