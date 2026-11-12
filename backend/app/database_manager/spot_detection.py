"""Fluorescent spots: LoG proposals, e-means initialization, Gaussian fits.

The final model is an elliptical Gaussian plus a local background plane.
This is a spot detector initialized by e-means, not ordinary spatial e-means.
References: https://big-fish.readthedocs.io/en/stable/detection/spots.html
            https://e-means.github.io/
"""

from dataclasses import dataclass
import io

import cv2
from faiss.contrib.e_means import NumpyEmeans
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure
from matplotlib.patches import Ellipse
import numpy as np
from scipy.ndimage import gaussian_laplace, maximum_filter
from scipy.optimize import least_squares, linear_sum_assignment


MAX_SPOTS = 16
MAX_AXIS_RATIO = 1.6
MIN_BIC_IMPROVEMENT = 10.0


@dataclass(frozen=True)
class Spot:
    center: np.ndarray
    covariance: np.ndarray
    amplitude: float
    snr: float
    bic_improvement: float


def _noise_sigma(image: np.ndarray, mask: np.ndarray) -> float:
    pairs = mask[1:, :] & mask[:-1, :]
    differences = np.diff(image, axis=0)[pairs]
    if len(differences) == 0:
        return 0.0
    return float(1.4826 * np.median(np.abs(differences - np.median(differences))) / np.sqrt(2))


def _peak_candidates(mask, signal, noise, sigma_min, sigma_max, snr, limit):
    scales = np.geomspace(sigma_min, sigma_max, 9)
    # Guard scales reject features smaller/larger than the requested range.
    scales = np.r_[sigma_min / np.sqrt(2), scales, sigma_max * np.sqrt(2)]
    responses = np.stack([-sigma**2 * gaussian_laplace(signal, sigma) for sigma in scales])
    peaks = (responses == maximum_filter(responses, size=(3, 3, 3))) & (responses > snr * noise / 4)
    peaks[[0, -1]] = False
    peaks &= mask[None]
    peaks &= (signal >= snr * noise)[None]
    locations = np.argwhere(peaks)
    ranked = sorted(locations, key=lambda loc: float(responses[tuple(loc)]), reverse=True)
    candidates = []
    for scale_id, y, x in ranked:
        center = np.array([x, y], dtype=float)
        if any(np.linalg.norm(center - other[0]) < 1.5 * min(scales[scale_id], other[1])
               for other in candidates):
            continue
        candidates.append((center, float(scales[scale_id])))
        if len(candidates) == limit:
            break
    return candidates


def _initial_centers(points, raw_xy, signal_values, candidates):
    """Reproducible intensity-weighted sampling for the official e-means API."""
    transform = np.linalg.lstsq(np.column_stack((raw_xy, np.ones(len(raw_xy)))), points, rcond=None)[0]
    seeds = np.array([center for center, _ in candidates])
    seed_points = np.column_stack((seeds, np.ones(len(seeds)))) @ transform
    weights = np.maximum(signal_values, 0)
    nearby = np.zeros(len(raw_xy), dtype=bool)
    for center, sigma in candidates:
        nearby |= np.sum((raw_xy - center) ** 2, axis=1) <= (3 * sigma) ** 2
    weights *= nearby
    if weights.sum() <= 0:
        return seeds, transform
    rng = np.random.default_rng(1234)
    selected = rng.choice(len(points), size=min(8192, max(1024, 256 * len(seeds))),
                          replace=True, p=weights / weights.sum())
    model = NumpyEmeans(2, len(seeds), nepochs=5, seed=1234)
    centers, _ = model.train(np.ascontiguousarray(points[selected], dtype=np.float32),
                              init_centroids=seed_points.astype(np.float32))
    rows, columns = linear_sum_assignment(np.sum((seed_points[:, None] - centers[None]) ** 2, axis=2))
    aligned = np.empty_like(centers)
    aligned[rows] = centers[columns]
    raw_centers = (aligned - transform[2]) @ np.linalg.pinv(transform[:2])
    # Keep dim candidates near their LoG seed even if a brighter peak attracts an initializer.
    for index, (seed, sigma) in enumerate(candidates):
        displacement = raw_centers[index] - seed
        raw_centers[index] = seed + displacement * min(1.0, sigma / max(np.linalg.norm(displacement), 1e-12))
    return raw_centers, transform


def _fit_spot(image, mask, seed, initial_center, sigma, noise, sigma_min, sigma_max, min_snr):
    radius = max(4, int(np.ceil(4 * sigma)))
    x0, y0 = np.floor(seed - radius).astype(int)
    x1, y1 = np.ceil(seed + radius + 1).astype(int)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(image.shape[1], x1), min(image.shape[0], y1)
    ys, xs = np.where(mask[y0:y1, x0:x1])
    if len(xs) < 20:
        return None
    xy = np.column_stack((xs + x0, ys + y0)) - seed
    values = image[ys + y0, xs + x0]
    baseline = float(np.median(values))
    scale = max(float(np.ptp(values)), noise)
    target = (values - baseline) / scale
    plane = np.column_stack((np.ones(len(xy)), xy))

    def model(parameters):
        amplitude, cx, cy, sx, sy, angle = parameters[:6]
        dx, dy = (xy - [cx, cy]).T
        c, s = np.cos(angle), np.sin(angle)
        a, b = c * dx + s * dy, -s * dx + c * dy
        background_plane = parameters[6] + xy[:, 0] * parameters[7] + xy[:, 1] * parameters[8]
        return amplitude * np.exp(-0.5 * ((a / sx) ** 2 + (b / sy) ** 2)) + background_plane

    center_limit = max(2.0, 1.5 * sigma)
    initial = [max(float(target.max()), 0.01), *(initial_center - seed), sigma, sigma, 0, 0, 0, 0]
    lower = [0, -center_limit, -center_limit, 0.35, 0.35, -np.pi, -np.inf, -np.inf, -np.inf]
    upper = [4, center_limit, center_limit, sigma_max * 3, sigma_max * 3, np.pi, np.inf, np.inf, np.inf]
    fit = least_squares(lambda parameters: model(parameters) - target, initial,
                         bounds=(lower, upper), max_nfev=100, x_scale='jac')
    if not fit.success or not np.isfinite(fit.x).all():
        return None
    amplitude, cx, cy, sx, sy, angle = fit.x[:6]
    if min(sx, sy) < sigma_min or max(sx, sy) > sigma_max or max(sx, sy) / min(sx, sy) > MAX_AXIS_RATIO:
        return None
    center = seed + [cx, cy]
    ix, iy = np.rint(center).astype(int)
    if not (0 <= iy < mask.shape[0] and 0 <= ix < mask.shape[1] and mask[iy, ix]):
        return None
    residual = (model(fit.x) - target) * scale
    local_noise = 1.4826 * np.median(np.abs(residual - np.median(residual)))
    fitted_snr = amplitude * scale / max(noise, local_noise)
    null_parameters = np.linalg.lstsq(plane, target, rcond=None)[0]
    null_residual = (np.sum(plane * null_parameters, axis=1) - target) * scale
    floor = len(values) * noise**2 * 1e-6
    delta_bic = len(values) * np.log(max(float(null_residual @ null_residual), floor) /
                                    max(float(residual @ residual), floor)) - 6 * np.log(len(values))
    if fitted_snr < min_snr or delta_bic < MIN_BIC_IMPROVEMENT:
        return None
    rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    covariance = rotation @ np.diag([sx**2, sy**2]) @ rotation.T
    return Spot(center, covariance, float(amplitude * scale), float(fitted_snr), float(delta_bic))


def detect_spots(image, coordinates, points, max_spots=3, sigma_min=1.0, sigma_max=4.0, min_snr=4.0):
    """Return up to max_spots accepted fits, in the supplied replot coordinate system."""
    if not isinstance(max_spots, int) or not 1 <= max_spots <= MAX_SPOTS:
        raise ValueError(f"Max spots must be an integer between 1 and {MAX_SPOTS}")
    if not all(np.isfinite(v) for v in (sigma_min, sigma_max, min_snr)) or not 0.5 <= sigma_min < sigma_max <= 10:
        raise ValueError("Spot widths must satisfy 0.5 <= min sigma < max sigma <= 10 px")
    if not 2 <= min_snr <= 30:
        raise ValueError("Min SNR must be between 2 and 30")
    image = np.asarray(image, dtype=np.float64)
    if image.ndim != 2 or not np.isfinite(image).all():
        raise ValueError("Spot detection requires a finite grayscale image")
    mask = np.zeros(image.shape, dtype=bool)
    mask[coordinates[:, 0], coordinates[:, 1]] = True
    raw_xy = coordinates[:, ::-1].astype(float)
    kernel_radius = int(np.ceil(3 * sigma_max))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * kernel_radius + 1,) * 2)
    background = cv2.morphologyEx(image, cv2.MORPH_OPEN, kernel)
    signal = image - background
    noise = max(_noise_sigma(image, mask), float(np.max(np.abs(image))) * 1e-6, 1e-9)
    signal_values = signal[coordinates[:, 0], coordinates[:, 1]]
    candidates = _peak_candidates(mask, signal, noise, sigma_min, sigma_max,
                                  min_snr, min(64, max(16, 4 * max_spots)))
    if not candidates:
        return [], signal_values, noise
    centers, transform = _initial_centers(points, raw_xy, signal_values, candidates)
    accepted = []
    for (seed, sigma), initial in zip(candidates, centers):
        spot = _fit_spot(image, mask, seed, initial, sigma, noise, sigma_min, sigma_max, min_snr)
        if spot is not None:
            accepted.append(spot)
    accepted.sort(key=lambda spot: spot.amplitude, reverse=True)
    distinct = []
    for spot in accepted:
        if any(np.linalg.norm(spot.center - other.center) < 1.5 * np.sqrt(
            min(np.linalg.eigvalsh(spot.covariance).min(), np.linalg.eigvalsh(other.covariance).min()))
               for other in distinct):
            continue
        distinct.append(spot)
        if len(distinct) == max_spots:
            break
    projected = [Spot(np.r_[spot.center, 1] @ transform,
                      transform[:2].T @ spot.covariance @ transform[:2],
                      spot.amplitude, spot.snr, spot.bic_improvement) for spot in distinct]
    return projected, signal_values, noise


def create_spot_plot(image, coordinates, points, contour, max_spots=3, sigma_min=1.0,
                     sigma_max=4.0, min_snr=4.0, channel='fluo1', dark_mode=False):
    spots, signal, _ = detect_spots(image, coordinates, points, max_spots, sigma_min, sigma_max, min_snr)
    background = '#10141c' if dark_mode else 'white'
    foreground = '#edf2f7' if dark_mode else '#202734'
    figure = Figure(figsize=(6, 6), facecolor=background, layout='constrained')
    FigureCanvasAgg(figure)
    ax = figure.subplots()
    ax.set_facecolor(background)
    ax.tick_params(colors=foreground)
    for spine in ax.spines.values():
        spine.set_color(foreground)
    positive = np.maximum(signal, 0)
    denominator = max(float(np.percentile(positive, 99.5)), 1e-9)
    normalized = np.clip(positive / denominator, 0, 1)
    scatter = ax.scatter(points[:, 0], points[:, 1], c=normalized, cmap='gray',
                          vmin=0, vmax=1, s=9, linewidths=0)
    outline = np.vstack((contour, contour[0]))
    ax.plot(outline[:, 0], outline[:, 1], color=foreground, linewidth=0.7)
    for index, spot in enumerate(spots):
        eigenvalues, eigenvectors = np.linalg.eigh(spot.covariance)
        angle = np.degrees(np.arctan2(eigenvectors[1, 1], eigenvectors[0, 1]))
        widths = 2 * np.sqrt(2 * np.log(2) * eigenvalues)
        ax.add_patch(Ellipse(spot.center, widths[1], widths[0], angle=angle,
                             fill=False, edgecolor='#55dfb1', linewidth=1.5))
        ax.plot(*spot.center, '+', color='#55dfb1', markersize=8)
        ax.annotate(str(index + 1), spot.center, xytext=(6, 8), textcoords='offset points',
                    color='#55dfb1', fontsize=10)
    ax.set_aspect('equal')
    ax.set_xlabel('u1 (px)', color=foreground)
    ax.set_ylabel('u2 (px)', color=foreground)
    ax.set_title(f'e-means spots | {channel.upper()} | {len(spots)} / {max_spots}\n'
                 f'σ = {sigma_min:g}–{sigma_max:g} px | SNR ≥ {min_snr:g}', color=foreground, fontsize=11)
    colorbar = figure.colorbar(scatter, ax=ax, fraction=0.035, pad=0.03)
    colorbar.set_label('Background-corrected intensity (display)', color=foreground, fontsize=8)
    colorbar.ax.tick_params(colors=foreground, labelsize=8)
    colorbar.outline.set_edgecolor(foreground)
    note = 'Centers + fitted FWHM outlines' if spots else 'No spots meet the width, roundness and SNR criteria'
    figure.text(0.5, 0.02, note, ha='center', color=foreground, fontsize=9)
    output = io.BytesIO()
    figure.savefig(output, format='png', dpi=140)
    return output.getvalue()
