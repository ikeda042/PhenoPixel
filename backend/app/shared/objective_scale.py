from typing import Literal

ObjectiveMagnification = Literal["100x", "60x"]

DEFAULT_OBJECTIVE_MAGNIFICATION: ObjectiveMagnification = "100x"
DEFAULT_PIXEL_SIZE_UM: float = 0.065
OBJECTIVE_PIXEL_SIZE_UM: dict[ObjectiveMagnification, float] = {
    "100x": DEFAULT_PIXEL_SIZE_UM,
    "60x": 0.108,
}


def pixel_size_for_objective(
    objective_magnification: ObjectiveMagnification,
) -> float:
    return OBJECTIVE_PIXEL_SIZE_UM[objective_magnification]


def normalize_pixel_size_um(value: object) -> float:
    try:
        pixel_size = float(value)
    except (TypeError, ValueError):
        return DEFAULT_PIXEL_SIZE_UM
    if pixel_size <= 0:
        return DEFAULT_PIXEL_SIZE_UM
    return pixel_size
