import io

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


def _read_even_lines(text: str) -> list[list[float]]:
    series: list[list[float]] = []
    data_line_index = 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("\ufeff"):
            line = line.lstrip("\ufeff")
        if line.startswith("#"):
            continue
        data_line_index += 1
        if data_line_index % 2 != 0:
            continue
        values: list[float] = []
        for value in line.split(","):
            value = value.strip()
            if not value:
                continue
            values.append(float(value))
        if values:
            series.append(values)
    return series


def _polyfit_extrema_x(
    coeffs: np.ndarray,
    x_min: float,
    x_max: float,
    tol: float = 1e-6,
) -> tuple[np.ndarray, np.ndarray]:
    deriv = np.polyder(coeffs)
    roots = np.roots(deriv)
    real_mask = np.isclose(roots.imag, 0.0, atol=1e-7)
    real_roots = roots[real_mask].real
    real_roots = real_roots[(real_roots >= x_min) & (real_roots <= x_max)]
    if real_roots.size == 0:
        return np.array([]), np.array([])
    real_roots.sort()
    second = np.polyder(deriv)
    maxima = []
    minima = []
    for root in real_roots:
        curvature = np.polyval(second, root)
        if abs(curvature) <= tol:
            continue
        if curvature < 0:
            maxima.append(root)
        else:
            minima.append(root)
    return np.array(maxima), np.array(minima)


def _plot_polyfit_extrema_overlay(
    ax: plt.Axes,
    series: list[list[float]],
    title: str,
    degree: int = 4,
    legend_label: str | None = None,
) -> None:
    for values in series:
        if len(values) <= degree:
            continue
        x = np.arange(len(values))
        try:
            coeffs = np.polyfit(x, values, degree)
        except np.linalg.LinAlgError:
            continue
        y_fit = np.polyval(coeffs, x)
        ax.plot(x, y_fit, color="tab:orange", alpha=0.35, linewidth=1)
        x_maxima, x_minima = _polyfit_extrema_x(coeffs, 0, len(values) - 1)
        if x_maxima.size:
            y_maxima = np.polyval(coeffs, x_maxima)
            ax.scatter(x_maxima, y_maxima, color="red", s=20, alpha=0.85, zorder=3)
        if x_minima.size:
            y_minima = np.polyval(coeffs, x_minima)
            ax.scatter(x_minima, y_minima, color="blue", s=20, alpha=0.85, zorder=3)
    ax.set_title(title)
    ax.set_xlabel("Index")
    ax.set_ylabel("8-bit brightness (polyfit)")
    ax.grid(True, alpha=0.2)
    if legend_label:
        handle = Line2D([], [], color="none", label=legend_label)
        ax.legend(
            handles=[handle],
            loc="upper right",
            frameon=False,
            handlelength=0,
            handletextpad=0.3,
        )


def _shade_center_band(
    ax: plt.Axes, series: list[list[float]], center_ratio: float
) -> None:
    if center_ratio <= 0:
        return
    max_len = max((len(values) for values in series), default=0)
    if max_len <= 1:
        return
    center = (max_len - 1) / 2.0
    half_width = center_ratio * (max_len - 1)
    left = max(0.0, center - half_width)
    right = min(max_len - 1, center + half_width)
    ax.axvspan(left, right, color="#d9d9d9", alpha=0.35, zorder=0)


def _split_series_by_center_minima(
    series: list[list[float]],
    degree: int,
    center_ratio: float,
    max_to_min_ratio: float,
) -> tuple[list[list[float]], list[list[float]]]:
    within = []
    outside = []
    for values in series:
        if len(values) <= degree:
            continue
        x = np.arange(len(values))
        try:
            coeffs = np.polyfit(x, values, degree)
        except np.linalg.LinAlgError:
            continue
        x_maxima, x_minima = _polyfit_extrema_x(coeffs, 0, len(values) - 1)
        if x_minima.size == 0:
            outside.append(values)
            continue
        center = (len(values) - 1) / 2.0
        threshold = center_ratio * (len(values) - 1)
        center_mask = np.abs(x_minima - center) <= threshold
        if not np.any(center_mask):
            outside.append(values)
            continue
        if x_maxima.size == 0:
            outside.append(values)
            continue
        y_minima = np.polyval(coeffs, x_minima[center_mask])
        min_value = np.min(y_minima)
        if np.isclose(min_value, 0.0):
            outside.append(values)
            continue
        y_maxima = np.polyval(coeffs, x_maxima)
        max_value = np.max(y_maxima)
        if np.isclose(max_value, 0.0):
            outside.append(values)
            continue
        if min_value / max_value <= max_to_min_ratio:
            within.append(values)
        else:
            outside.append(values)
    return within, outside


def build_hu_separation_overlay(
    csv_payloads: list[tuple[str, bytes]],
    degree: int = 4,
    center_ratio: float = 0.15,
    max_to_min_ratio: float = 0.9,
    dpi: int = 300,
) -> io.BytesIO:
    if not csv_payloads:
        raise ValueError("No CSV data provided.")

    series_list: list[list[list[float]]] = []
    titles: list[str] = []
    for filename, content in csv_payloads:
        text = content.decode("utf-8", errors="replace")
        series_list.append(_read_even_lines(text))
        titles.append(filename or "uploaded.csv")

    nrows = len(series_list)
    fig_height = max(1, 4 * nrows)
    fig, axes = plt.subplots(nrows=nrows, ncols=2, figsize=(12, fig_height))
    axes = np.atleast_2d(axes)
    percent = int(center_ratio * 100)
    for row_index, (series, title) in enumerate(zip(series_list, titles)):
        within, outside = _split_series_by_center_minima(
            series,
            degree=degree,
            center_ratio=center_ratio,
            max_to_min_ratio=max_to_min_ratio,
        )
        total = len(series)
        within_pct = 0.0 if total == 0 else (len(within) / total * 100)
        outside_pct = 0.0 if total == 0 else (len(outside) / total * 100)
        within_legend = f"minima within center +/-{percent}% | left {within_pct:.1f}%"
        outside_legend = f"minima outside center +/-{percent}% | right {outside_pct:.1f}%"
        _shade_center_band(axes[row_index, 0], series, center_ratio)
        _shade_center_band(axes[row_index, 1], series, center_ratio)
        _plot_polyfit_extrema_overlay(
            axes[row_index, 0], within, title, degree=degree, legend_label=within_legend
        )
        _plot_polyfit_extrema_overlay(
            axes[row_index, 1], outside, title, degree=degree, legend_label=outside_legend
        )

    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi)
    buf.seek(0)
    plt.close(fig)
    return buf
