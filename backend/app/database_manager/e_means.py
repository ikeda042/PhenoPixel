"""e-means clustering and plotting of the cell's 2D replot coordinates.

Uses the official CPU implementation: https://e-means.github.io/
Bessa et al., e-means (2026), https://arxiv.org/abs/2611.09501.
"""

import io

from faiss.contrib.e_means import NumpyEmeans
from matplotlib import colormaps
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.colors import ListedColormap
from matplotlib.figure import Figure
from matplotlib.patches import PathPatch
from matplotlib.path import Path
import numpy as np


MAX_CLUSTERS = 64
EPOCHS = 5


def cluster_replot_points(
    points: np.ndarray, n_clusters: int
) -> tuple[NumpyEmeans, np.ndarray, float]:
    points = np.ascontiguousarray(points, dtype=np.float32)
    if points.ndim != 2 or points.shape[1] != 2 or not np.isfinite(points).all():
        raise ValueError("Replot coordinates must be finite 2D points")
    if not isinstance(n_clusters, int) or not 1 <= n_clusters <= MAX_CLUSTERS:
        raise ValueError(f"Clusters must be an integer between 1 and {MAX_CLUSTERS}")
    if n_clusters > len(points):
        raise ValueError(f"Clusters cannot exceed the number of cell pixels ({len(points)})")

    model = NumpyEmeans(2, n_clusters, nepochs=EPOCHS, seed=1234)
    model.train(points)
    # Training labels precede finalization; reassign so colors match the boundaries.
    distances, labels = model.assign(points)
    return model, labels, float(distances.mean(dtype=np.float64))


def create_e_means_plot(
    points: np.ndarray, contour: np.ndarray, n_clusters: int, dark_mode: bool = False
) -> bytes:
    model, labels, mse = cluster_replot_points(points, n_clusters)
    background = "#10141c" if dark_mode else "white"
    foreground = "#edf2f7" if dark_mode else "#202734"
    if n_clusters <= 10:
        colors = ListedColormap(colormaps["tab10"].colors[:n_clusters])
    elif n_clusters <= 20:
        colors = ListedColormap(colormaps["tab20"].colors[:n_clusters])
    else:
        colors = ListedColormap(colormaps["hsv"](np.linspace(0, 1, n_clusters, endpoint=False)))
    figure = Figure(figsize=(6, 6), facecolor=background, layout="constrained")
    FigureCanvasAgg(figure)
    ax = figure.subplots()
    ax.set_facecolor(background)
    ax.tick_params(colors=foreground, direction="in")
    for spine in ax.spines.values():
        spine.set_color(foreground)

    low, high = points.min(axis=0), points.max(axis=0)
    margin = max(float(np.max(high - low)) * 0.08, 2.0)
    x = np.linspace(low[0] - margin, high[0] + margin, 240)
    y = np.linspace(low[1] - margin, high[1] + margin, 240)
    xx, yy = np.meshgrid(x, y)
    _, regions = model.assign(np.column_stack((xx.ravel(), yy.ravel())))
    regions = regions.reshape(xx.shape)
    outline = np.vstack((contour, contour[0]))
    clip = PathPatch(Path(outline), transform=ax.transData)
    field = ax.pcolormesh(
        xx, yy, regions, cmap=colors, vmin=-0.5, vmax=n_clusters - 0.5,
        shading="nearest", alpha=0.18, rasterized=True,
    )
    field.set_clip_path(clip)
    for cluster in np.unique(regions):
        region = regions == cluster
        if region.all():
            continue
        boundary = ax.contour(xx, yy, region, levels=[0.5], colors=foreground,
                              linewidths=0.6, alpha=0.45)
        boundary.set_clip_path(clip)
    ax.scatter(points[:, 0], points[:, 1], c=labels, cmap=colors,
               vmin=-0.5, vmax=n_clusters - 0.5, s=5, linewidths=0, alpha=0.85)
    ax.plot(outline[:, 0], outline[:, 1], color=foreground, linewidth=1,
            label="Cell contour")
    centers = model.centroids
    ax.scatter(centers[:, 0], centers[:, 1], c=np.arange(n_clusters), cmap=colors,
               vmin=-0.5, vmax=n_clusters - 0.5, marker="X", s=100,
               edgecolors=foreground, linewidths=1.2, label="Centroids", zorder=4)
    for index, center in enumerate(centers):
        ax.annotate(str(index + 1), center, xytext=(5, 6),
                    textcoords="offset points", color=foreground, fontsize=8)
    ax.set(xlim=(x[0], x[-1]), ylim=(y[0], y[-1]), aspect="equal")
    ax.set_xlabel("u1 (px)", color=foreground)
    ax.set_ylabel("u2 (px)", color=foreground)
    ax.set_title(f"e-means | k = {n_clusters}\n"
                 f"{len(points):,} pixels | {EPOCHS} epochs | MSE = {mse:.3f} px²",
                 color=foreground, fontsize=11, pad=12)
    ax.legend(loc="upper right", facecolor=background, edgecolor=foreground,
              labelcolor=foreground, fontsize=8)
    output = io.BytesIO()
    figure.savefig(output, format="png", dpi=140)
    return output.getvalue()
