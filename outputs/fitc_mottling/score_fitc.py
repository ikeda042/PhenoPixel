"""Measure three intracellular FITC pattern scores in trusted PhenoPixel databases.

From the repository root, for example:
  venv/bin/python outputs/fitc_mottling/score_fitc.py backend/app/databases/26*.db

Print one CSV row per manual_label=1 cell. --json outputs the same data as JSON.
"""

import argparse
import csv
import json
import math
from pathlib import Path
import sqlite3
import sys

import cv2
import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.bulk_engine.heatmap_bulk_core import _decode_grayscale_preserve_depth, _parse_contour_points


def masked_blur(values, mask, sigma):
    """Normalize by available mask weight so the dark exterior cannot enter."""
    numerator = ndi.gaussian_filter(values * mask, sigma, mode="constant")
    weight = ndi.gaussian_filter(mask.astype(float), sigma, mode="constant")
    return np.divide(numerator, weight, out=np.zeros_like(numerator), where=weight > 0)


def texture_maps(signal, core, distance_um, pixel_um, mean):
    """Return the signed bandpass response and the connected bright patches."""
    # Subtract typical brightness at the same distance from the outline.
    # Pool the deepest 10% to avoid fitting a baseline from only a few pixels.
    bands = np.floor(np.minimum(distance_um, np.quantile(distance_um[core], 0.90)) / 0.13)
    residual = np.zeros(signal.shape, dtype=float)
    for band in np.unique(bands[core]):
        group = core & (bands == band)
        residual[group] = signal[group] - np.median(signal[group])
    response = (masked_blur(residual, core, 0.13 / pixel_um)
                - masked_blur(residual, core, 0.39 / pixel_um))

    islands, count_islands = ndi.label(core & (response > 0.20 * mean),
                                       structure=np.ones((3, 3), dtype=bool))
    sizes = np.bincount(islands[core], minlength=count_islands + 1)
    eligible = sizes * pixel_um ** 2 >= 0.029
    eligible[0] = False
    return response, eligible[islands]


def measure(image, mask, pixel_um):
    # Distances refer to pixel centers. At 65 nm/px this removes one edge pixel
    # and estimates background 4–8 px outside the filled contour.
    distance = ndi.distance_transform_edt(mask) * pixel_um
    exterior = ndi.distance_transform_edt(~mask) * pixel_um
    core = distance > 0.065
    ring = (exterior > 0.26) & (exterior <= 0.52)
    if not core.any() or not ring.any():
        raise ValueError("Empty cell interior or background ring")

    background = float(np.median(image[ring]))
    ring_noise = float(1.4826 * np.median(np.abs(image[ring].astype(float) - background)))
    signal = np.maximum(image.astype(float) - background, 0)
    values = signal[core]
    total = float(values.sum())
    mean = float(values.mean())
    ceiling = np.iinfo(image.dtype).max
    saturation = float(np.mean(image[core] == ceiling))
    flags = []
    if saturation > 0.01:
        flags.append("saturated")
    if mean <= 3 * max(ring_noise, 1):
        flags.append("low_signal")

    top_share = mottling = excess_share = None
    if total > 0:
        count = math.ceil(0.10 * values.size)
        top_share = float(np.partition(values, -count)[-count:].sum() / total)

        response, spots = texture_maps(signal, core, distance, pixel_um, mean)
        mottling = float(np.sqrt(np.mean(response[core] ** 2)) / mean)

        # Bound the excess by the local signal so its fraction is in [0, 1].
        excess_share = float(np.minimum(response[spots], signal[spots]).sum() / total)

    return dict(
        mottling_rms=mottling, focus_excess_fraction=excess_share,
        top10_fraction_core=top_share, qc_pass=not flags,
        qc_flags="|".join(flags) or "pass", saturation_fraction=saturation,
        mean_signal=mean, background=background, background_noise_mad=ring_noise,
        core_area_pixels=int(values.size), stored_bit_depth=image.dtype.itemsize * 8,
        pixel_size_um=pixel_um,
    )


def read_cells(path):
    if not path.is_file():
        raise FileNotFoundError(path)
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT cell_id, img_fluo1, contour, pixel_size_um FROM cells "
            "WHERE CAST(manual_label AS TEXT) = '1' ORDER BY id"
        )
        for cell_id, blob, outline, pixel_um in rows:
            image = _decode_grayscale_preserve_depth(blob)
            _, contour = _parse_contour_points(outline)
            mask = np.zeros(image.shape, dtype=np.uint8)
            cv2.fillPoly(mask, [contour], 1)
            if pixel_um is None or not np.isfinite(pixel_um) or pixel_um <= 0:
                raise ValueError(f"Missing pixel calibration in {path.name} / {cell_id}")
            yield dict(database=path.name, cell_id=cell_id, manual_label=1,
                       **measure(image, mask.astype(bool), pixel_um))
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("databases", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    records = [cell for db in args.databases for cell in read_cells(db)]
    if args.json:
        print(json.dumps(records, allow_nan=False))
    elif records:
        writer = csv.DictWriter(sys.stdout, fieldnames=records[0].keys())
        writer.writeheader()
        writer.writerows(records)


if __name__ == "__main__":
    main()
