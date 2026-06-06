import os
import shutil
import pickle
import random
import re
import logging
from functools import lru_cache
from dataclasses import dataclass
from pathlib import Path
from typing import Generator, Literal, Optional

import cv2
import nd2reader
import numpy as np
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image
from sqlalchemy import BLOB, Column, FLOAT, Index, Integer, String, create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeMeta, Session, declarative_base, sessionmaker

from pydantic import BaseModel, Field, ValidationInfo, field_validator

from autoannotation.features import extract_feature_dict
from autoannotation.models import AutoAnnotator, load_model

from app.shared.objective_scale import (
    DEFAULT_OBJECTIVE_MAGNIFICATION,
    ObjectiveMagnification,
    pixel_size_for_objective,
)


APP_DIR: Path = Path(__file__).resolve().parents[1]
DATABASES_DIR: Path = APP_DIR / "databases"
EXTRACTED_DATA_DIR: Path = APP_DIR / "extracted_data"
TEMPDATA_DIR: Path = APP_DIR / "tempdata"
AUTOANNOTATION_MODEL_PATH: Path = (
    APP_DIR.parent / "autoannotation" / "artifacts" / "autoannotator.pkl"
)
LOGGER: logging.Logger = logging.getLogger("uvicorn.error")


def _get_temp_dir(ulid: str) -> str:
    return str(TEMPDATA_DIR / f"TempData{ulid}")


def second_pca_variance_from_blob(contour_blob: bytes) -> Optional[float]:
    """
    Deserialize a contour BLOB and return the variance of the second PCA axis
    (smaller eigenvalue). Returns None if the contour is invalid.
    """
    try:
        contour = pickle.loads(contour_blob)
    except Exception:
        return None

    # Accept common contour layouts, including OpenCV-style (N, 1, 2).
    arr = np.asarray(contour)
    if arr.size == 0:
        return None

    arr = np.squeeze(arr)

    if arr.ndim == 1:
        if arr.size < 4 or arr.size % 2 != 0:
            return None
        arr = arr.reshape(-1, 2)
    elif arr.ndim == 2:
        if arr.shape[0] == 2 and arr.shape[1] != 2:
            arr = arr.T
    elif arr.ndim == 3 and arr.shape[-1] == 2:
        arr = arr.reshape(-1, 2)
    else:
        return None

    if arr.shape[1] < 2:
        return None
    if arr.shape[1] > 2:
        arr = arr[:, :2]

    if arr.shape[0] < 2:
        return None

    points = arr.astype(float, copy=False)
    centered = points - points.mean(axis=0, keepdims=True)
    cov = np.cov(centered, rowvar=False)
    if cov.shape != (2, 2):
        return None

    eigvals = np.linalg.eigvalsh(cov)
    return float(max(eigvals[0], 0.0))


def convexity_from_contour(contour: object) -> Optional[float]:
    """
    Compute convexity = hull_perimeter / perimeter from a contour-like object.
    Returns None if the contour is invalid or the perimeter is zero.
    """
    arr = np.asarray(contour)
    if arr.size == 0:
        return None

    arr = np.squeeze(arr)

    if arr.ndim == 1:
        if arr.size < 4 or arr.size % 2 != 0:
            return None
        arr = arr.reshape(-1, 2)
    elif arr.ndim == 2:
        if arr.shape[0] == 2 and arr.shape[1] != 2:
            arr = arr.T
    elif arr.ndim == 3 and arr.shape[-1] == 2:
        arr = arr.reshape(-1, 2)
    else:
        return None

    if arr.shape[1] < 2:
        return None
    if arr.shape[1] > 2:
        arr = arr[:, :2]

    if arr.shape[0] < 2:
        return None

    points = arr.astype(float, copy=False)
    diffs = np.diff(points, axis=0)
    perimeter = float(
        np.hypot(diffs[:, 0], diffs[:, 1]).sum()
        + np.hypot(*(points[0] - points[-1]))
    )
    if perimeter == 0.0:
        return None

    unique = np.unique(points, axis=0)
    if unique.shape[0] <= 1:
        return None
    if unique.shape[0] == 2:
        hull = unique
    else:
        order = np.lexsort((unique[:, 1], unique[:, 0]))
        pts = unique[order]

        def cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

        lower = []
        for p in pts:
            while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
                lower.pop()
            lower.append(p)

        upper = []
        for p in reversed(pts):
            while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
                upper.pop()
            upper.append(p)

        hull = np.vstack((lower[:-1], upper[:-1]))

    hull_diffs = np.diff(hull, axis=0)
    hull_perimeter = float(
        np.hypot(hull_diffs[:, 0], hull_diffs[:, 1]).sum()
        + np.hypot(*(hull[0] - hull[-1]))
    )
    return hull_perimeter / perimeter


def convexity_from_blob(contour_blob: bytes) -> Optional[float]:
    """
    Deserialize a contour BLOB and compute convexity.
    Returns None if the contour is invalid or cannot be deserialized.
    """
    try:
        contour = pickle.loads(contour_blob)
    except Exception:
        return None
    return convexity_from_contour(contour)


def screen_contour(contour_blob: bytes) -> bool:
    variance = second_pca_variance_from_blob(contour_blob)
    convexity = convexity_from_blob(contour_blob)
    return (
        variance is not None
        and variance <= 120
        and convexity is not None
        and convexity > 0.85
    )


@lru_cache(maxsize=1)
def _load_autoannotation_model() -> AutoAnnotator | None:
    configured_path = os.getenv("PHENOPIXEL_AUTOANNOTATION_MODEL")
    model_path = Path(configured_path) if configured_path else AUTOANNOTATION_MODEL_PATH
    if not model_path.is_file():
        LOGGER.warning(
            "Auto annotation model not found at %s; using contour heuristic.",
            model_path,
        )
        return None
    try:
        return load_model(model_path)
    except Exception as exc:
        LOGGER.warning(
            "Failed to load auto annotation model from %s; using contour heuristic: %s",
            model_path,
            exc,
        )
        return None


def auto_annotate_cell(
    *,
    perimeter: float,
    area: float,
    img_ph: bytes | None,
    img_fluo1: bytes | None,
    img_fluo2: bytes | None,
    contour_blob: bytes,
) -> int | str:
    model = _load_autoannotation_model()
    if model is None:
        return 1 if screen_contour(contour_blob) else "N/A"

    try:
        features = extract_feature_dict(
            perimeter=perimeter,
            area=area,
            img_ph=img_ph,
            img_fluo1=img_fluo1,
            img_fluo2=img_fluo2,
            contour=contour_blob,
        )
        _, predictions = model.predict_feature_dicts([features])
    except Exception as exc:
        LOGGER.warning(
            "ML auto annotation failed; using contour heuristic: %s",
            exc,
        )
        return 1 if screen_contour(contour_blob) else "N/A"

    return 1 if int(predictions[0]) == 1 else "N/A"


class FrameSplitConfig(BaseModel):
    frame_start: int = Field(ge=0)
    frame_end: int = Field(ge=0)
    db_name: str

    @field_validator("db_name")
    @classmethod
    def validate_db_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("db_name cannot be empty")
        return value

    @field_validator("frame_end")
    @classmethod
    def validate_range(cls, value: int, info: ValidationInfo) -> int:
        frame_start = info.data.get("frame_start")
        if frame_start is not None and value < frame_start:
            raise ValueError("frame_end must be greater than or equal to frame_start")
        return value




def get_ulid() -> str:
    """Return a fake ULID using random digits."""
    # NOTE: This is a placeholder implementation
    return "".join(str(random.randint(0, 9)) for _ in range(16))


Base: DeclarativeMeta = declarative_base()


@dataclass
class FrameSplitRange:
    frame_start: int
    frame_end: int
    db_name: str
    db_path: str


class Cell(Base):
    __tablename__ = "cells"
    __table_args__ = (
        Index("idx_cells_cell_id", "cell_id"),
        Index("idx_cells_manual_label", "manual_label"),
    )
    id = Column(Integer, primary_key=True)
    cell_id = Column(String)
    label_experiment = Column(String)
    manual_label = Column(Integer)
    perimeter = Column(FLOAT)
    area = Column(FLOAT)
    img_ph = Column(BLOB)
    img_fluo1 = Column(BLOB, nullable=True)
    img_fluo2 = Column(BLOB, nullable=True)
    contour = Column(BLOB)
    center_x = Column(FLOAT)
    center_y = Column(FLOAT)
    user_id = Column(String, nullable=True)
    objective_magnification = Column(String, nullable=True)
    pixel_size_um = Column(FLOAT, nullable=True)


def get_session(dbname: str) -> Generator[Session, None, None]:
    engine = create_engine(
        f"sqlite:///{dbname}",
        echo=False,
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    session_factory = sessionmaker(engine, expire_on_commit=False)
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def create_database(dbname: str) -> Engine:
    db_dir = os.path.dirname(dbname)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{dbname}",
        echo=False,
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("PRAGMA journal_mode=DELETE;"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_cells_cell_id ON cells (cell_id)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS idx_cells_manual_label ON cells (manual_label)")
        )
    return engine


class SyncChores:
    @staticmethod
    def to_grayscale_preserve_depth(image) -> np.ndarray:
        array = np.squeeze(np.asarray(image))
        if array.ndim == 2:
            return array
        if array.ndim == 3:
            if array.shape[2] == 1:
                return array[:, :, 0]
            if array.shape[2] == 4:
                array = array[:, :, :3]
            return cv2.cvtColor(array, cv2.COLOR_BGR2GRAY)
        raise ValueError("Unsupported image dimensions")

    @staticmethod
    def process_image(array) -> np.ndarray:
        """
        PH画像用の処理関数：輪郭検出に使うため 0-255 の8-bitへ正規化する。
        """
        array = SyncChores.to_grayscale_preserve_depth(array).astype(np.float32)
        min_val = float(array.min())
        max_val = float(array.max())
        if max_val <= min_val:
            return np.zeros_like(array, dtype=np.uint8)
        array = (array - min_val) / (max_val - min_val)
        return (array * 255).astype(np.uint8)

    @staticmethod
    def ensure_ph_uint8(image) -> np.ndarray:
        image_gray = SyncChores.to_grayscale_preserve_depth(image)
        if image_gray.dtype == np.uint8:
            return image_gray
        return SyncChores.process_image(image_gray)

    @staticmethod
    def preserve_raw_fluorescence_image(array, layer: str) -> np.ndarray:
        """
        蛍光画像は解析用に raw intensity を保持する。
        """
        array = SyncChores.to_grayscale_preserve_depth(array)
        if np.issubdtype(array.dtype, np.floating):
            if not np.all(np.isfinite(array)):
                raise ValueError(f"{layer} image contains non-finite intensity values")
            if float(np.min(array)) < 0:
                raise ValueError(f"{layer} image contains negative intensity values")
            array = np.rint(array)
            max_val = float(np.max(array)) if array.size else 0.0
            if max_val <= np.iinfo(np.uint8).max:
                return array.astype(np.uint8)
            if max_val <= np.iinfo(np.uint16).max:
                return array.astype(np.uint16)
            raise ValueError(
                f"{layer} image intensity max {max_val:g} exceeds uint16 storage"
            )
        if not np.issubdtype(array.dtype, np.integer):
            raise ValueError(
                f"{layer} image must use an integer dtype to preserve raw intensity"
            )
        if array.dtype not in (np.uint8, np.uint16):
            raise ValueError(
                f"{layer} image dtype {array.dtype} is not supported for raw storage"
            )
        return array

    @staticmethod
    def prepare_extracted_layer(array, layer: str) -> np.ndarray:
        if layer == "PH":
            return SyncChores.process_image(array)
        return SyncChores.preserve_raw_fluorescence_image(array, layer)

    @staticmethod
    def load_image_unchanged(path: str) -> np.ndarray | None:
        return cv2.imread(path, cv2.IMREAD_UNCHANGED)

    @staticmethod
    def save_images(num_frames, file_name, num_channels, ulid) -> None:
        """
        画像を保存し、MultipageTIFFとして出力する。
        """
        all_images = []
        for i in range(num_frames):
            if num_channels > 1:
                for j in range(num_channels):
                    all_images.append(
                        Image.open(f"nd2totiff{ulid}/image_{i}_channel_{j}.tif")
                    )
            else:
                all_images.append(Image.open(f"nd2totiff{ulid}/image_{i}.tif"))

        all_images[0].save(
            f"{file_name.split('/')[-1].split('.')[0]}.tif",
            save_all=True,
            append_images=all_images[1:],
        )

        for img in all_images:
            img.close()

    @staticmethod
    def extract_nd2(file_name: str, mode: str, ulid: str, reverse: bool = False) -> int:
        """
        nd2ファイルをフレーム別TIFFとして展開する。
        """
        temp_dir = _get_temp_dir(ulid)
        layer_specs: dict[str, list[tuple[int, str | None]]] = {
            "quad_layer": [(0, "PH"), (1, "Fluo1"), (2, "Fluo2"), (3, None)],
            "triple_layer": [(0, "PH"), (1, "Fluo1"), (2, "Fluo2")],
            "single_layer": [(0, "PH")],
            "dual_layer": (
                [(1, "PH"), (0, "Fluo1")]
                if reverse
                else [(0, "PH"), (1, "Fluo1")]
            ),
        }
        specs = layer_specs.get(mode)
        if specs is None:
            raise ValueError("Invalid layer mode")
        os.makedirs(temp_dir, exist_ok=True)
        for _source_idx, layer in specs:
            if layer is not None:
                os.makedirs(f"{temp_dir}/{layer}", exist_ok=True)

        with nd2reader.ND2Reader(file_name) as images:
            print(f"Available axes: {images.axes}")
            print(f"Sizes: {images.sizes}")

            images.bundle_axes = "cyx" if "c" in images.axes else "yx"
            images.iter_axes = "v"

            num_channels = images.sizes.get("c", 1)
            print(f"Total images: {len(images)}")
            print(f"Channels: {num_channels}")
            print("##############################################")

            frames_processed = 0
            for n in range(len(images)):
                try:
                    frame = images[n]
                except KeyError as e:
                    print(f"KeyError while reading frame {n}: {e}. Stopping extraction.")
                    break
                for source_idx, layer in specs:
                    if layer is None:
                        continue
                    if num_channels > 1:
                        if source_idx >= num_channels:
                            continue
                        array = np.asarray(frame[source_idx])
                    else:
                        if source_idx != 0:
                            continue
                        array = np.asarray(frame)
                    array = np.squeeze(array)
                    array = SyncChores.prepare_extracted_layer(array, layer)
                    Image.fromarray(array).save(f"{temp_dir}/{layer}/{n}.tif")
                frames_processed += 1
        return frames_processed * len(specs)

    @staticmethod
    def extract_tiff(
        tiff_path: str,
        ulid: str,
        mode: Literal[
            "single_layer", "dual_layer", "triple_layer", "quad_layer"
        ] = "dual_layer",
        reverse: bool = False,
    ) -> int:
        temp_dir = _get_temp_dir(ulid)
        os.makedirs(temp_dir, exist_ok=True)
        folders = [
            folder
            for folder in os.listdir(temp_dir)
            if os.path.isdir(os.path.join(temp_dir, folder))
        ]

        layers = {
            "quad_layer": ["Fluo1", "Fluo2", "PH"],  # Fluo3 is ignored
            "triple_layer": ["Fluo1", "Fluo2", "PH"],
            "single_layer": ["PH"],
            "dual_layer": ["Fluo1", "PH"],
        }

        for layer in layers.get(mode, []):
            os.makedirs(f"{temp_dir}/{layer}", exist_ok=True)

        with Image.open(tiff_path) as tiff:
            num_pages = tiff.n_frames
            img_num = 0

            layer_map = {
                "quad_layer": [
                    (0, "PH"),
                    (1, "Fluo1"),
                    (2, "Fluo2"),
                    (3, None),  # skip Fluo3
                ],
                "triple_layer": [(0, "PH"), (1, "Fluo1"), (2, "Fluo2")],
                "single_layer": [(0, "PH")],
                "dual_layer": (
                    [(0, "PH"), (1, "Fluo1")]
                    if not reverse
                    else [(1, "PH"), (0, "Fluo1")]
                ),
            }

            for i in range(num_pages):
                tiff.seek(i)
                layer_idx = i % len(layer_map[mode])
                layer = layer_map[mode][layer_idx][1]
                if layer is not None:
                    filename = f"{temp_dir}/{layer}/{img_num}.tif"
                    print(filename)
                    tiff.save(filename, format="TIFF")
                if layer_idx == len(layer_map[mode]) - 1:
                    img_num += 1

        return num_pages

    @staticmethod
    def cleanup(directory: str) -> None:
        """
        指定されたディレクトリを削除する。
        """
        for root, dirs, files in os.walk(directory, topdown=False):
            for name in files:
                os.remove(os.path.join(root, name))
            for name in dirs:
                os.rmdir(os.path.join(root, name))
        os.rmdir(directory)

    @staticmethod
    def get_contour_center(contour) -> tuple[int, int]:
        # 輪郭のモーメントを計算して重心を求める
        M = cv2.moments(contour)
        if M["m00"] == 0:
            return 0, 0
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])
        return cx, cy

    @staticmethod
    def crop_contours(
        image,
        contours,
        output_size,
        centers: list[tuple[int, int]] | None = None,
    ) -> list[np.ndarray]:
        cropped_images = []
        for index, contour in enumerate(contours):
            # 各輪郭の中心座標を取得
            if centers is not None and index < len(centers):
                cx, cy = centers[index]
            else:
                cx, cy = SyncChores.get_contour_center(contour)
            # 　中心座標が画像の中心から離れているものを除外
            if cx > 400 and cx < 2000 and cy > 400 and cy < 2000:
                # 切り抜く範囲を計算
                x1 = max(0, cx - output_size[0] // 2)
                y1 = max(0, cy - output_size[1] // 2)
                x2 = min(image.shape[1], cx + output_size[0] // 2)
                y2 = min(image.shape[0], cy + output_size[1] // 2)
                # 画像を切り抜く
                cropped = image[y1:y2, x1:x2]
                cropped_images.append(cropped)
        return cropped_images

    @staticmethod
    def init(
        input_filename: str,
        num_tiff: int,
        ulid: str,
        param1: int = 130,
        image_size: int = 200,
        mode: Literal[
            "single_layer",
            "dual_layer",
            "triple_layer",
            "quad_layer",
        ] = "dual_layer",
        contour_dir: str | None = None,
    ) -> int:
        temp_dir = _get_temp_dir(ulid)
        print(f"Initializing {temp_dir}")
        print("}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}")
        if mode == "quad_layer":
            set_num = 4
            init_folders = ["Fluo1", "Fluo2", "PH", "frames", "app_data"]
        elif mode == "triple_layer":
            set_num = 3
            init_folders = ["Fluo1", "Fluo2", "PH", "frames", "app_data"]
        elif mode == "single_layer":
            set_num = 1
            init_folders = ["PH", "frames", "app_data"]
        else:
            set_num = 2
            init_folders = ["Fluo1", "PH", "frames", "app_data"]

        os.makedirs(temp_dir, exist_ok=True)

        init_folders = [f"{temp_dir}/{d}" for d in init_folders]
        folders = [
            folder
            for folder in os.listdir(f"{temp_dir}")
            if os.path.isdir(os.path.join(".", folder))
        ]
        for i in [i for i in init_folders if i not in folders]:
            try:
                os.mkdir(f"{i}")
            except:
                continue
        # フォルダの作成
        def _ensure_dir(path: str) -> None:
            try:
                os.makedirs(path)
            except Exception as exc:
                print(exc)

        if contour_dir is None:
            stem = os.path.splitext(os.path.basename(input_filename))[0]
            contour_dir = str(EXTRACTED_DATA_DIR / stem)
        _ensure_dir(contour_dir)
        for i in range(num_tiff // set_num):
            frame_dir = f"{temp_dir}/frames/tiff_{i}"
            dirs = [
                frame_dir,
                f"{frame_dir}/Cells",
                f"{frame_dir}/Cells/ph",
                f"{frame_dir}/Cells/fluo1",
            ]
            if mode in ("triple_layer", "quad_layer"):
                dirs.extend(
                    [
                        f"{frame_dir}/Cells/fluo2",
                        f"{frame_dir}/Cells/fluo2_adjusted",
                        f"{frame_dir}/Cells/fluo2_contour",
                    ]
                )
            for path in dirs:
                _ensure_dir(path)
        loop_num = num_tiff // set_num if mode != "single_layer" else num_tiff
        for k in range(loop_num):
            image_ph_raw = SyncChores.load_image_unchanged(f"{temp_dir}/PH/{k}.tif")
            if image_ph_raw is None:
                continue
            image_ph = SyncChores.process_image(image_ph_raw)
            if mode == "dual_layer" or mode == "triple_layer" or mode == "quad_layer":
                image_fluo_1 = SyncChores.load_image_unchanged(f"{temp_dir}/Fluo1/{k}.tif")
                if image_fluo_1 is None:
                    continue
                image_fluo_1 = SyncChores.preserve_raw_fluorescence_image(
                    image_fluo_1, "Fluo1"
                )
            if mode == "triple_layer" or mode == "quad_layer":
                image_fluo_2 = SyncChores.load_image_unchanged(f"{temp_dir}/Fluo2/{k}.tif")
                if image_fluo_2 is None:
                    continue
                image_fluo_2 = SyncChores.preserve_raw_fluorescence_image(
                    image_fluo_2, "Fluo2"
                )
            img_gray = image_ph

            # ２値化を行う
            ret, thresh = cv2.threshold(img_gray, param1, 255, cv2.THRESH_BINARY)
            img_canny = cv2.Canny(thresh, 0, 130)
            contours, hierarchy = cv2.findContours(
                img_canny, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
            )
            filtered_contours = []
            contour_centers: list[tuple[int, int]] = []
            for contour in contours:
                if cv2.contourArea(contour) < 300:
                    continue
                moments = cv2.moments(contour)
                if moments["m00"] == 0:
                    continue
                cx = moments["m10"] / moments["m00"]
                cy = moments["m01"] / moments["m00"]
                if 400 < cx < 1700 and 400 < cy < 1700:
                    filtered_contours.append(contour)
                    contour_centers.append((int(cx), int(cy)))
            contours = filtered_contours

            output_size = (image_size, image_size)

            cropped_images_ph = SyncChores.crop_contours(
                image_ph, contours, output_size, contour_centers
            )
            if mode == "triple_layer" or mode == "dual_layer" or mode == "quad_layer":
                cropped_images_fluo_1 = SyncChores.crop_contours(
                    image_fluo_1, contours, output_size, contour_centers
                )
            if mode == "triple_layer" or mode == "quad_layer":
                cropped_images_fluo_2 = SyncChores.crop_contours(
                    image_fluo_2, contours, output_size, contour_centers
                )

            image_ph_copy = cv2.cvtColor(image_ph, cv2.COLOR_GRAY2BGR)
            cv2.drawContours(image_ph_copy, contours, -1, (0, 255, 0), 3)
            cv2.imwrite(f"{contour_dir}/{k}.png", image_ph_copy)
            n = 0
            if mode in ("triple_layer", "quad_layer"):
                for ph, fluo1, fluo2 in zip(
                    cropped_images_ph, cropped_images_fluo_1, cropped_images_fluo_2
                ):
                    if (
                        len(ph) == output_size[0]
                        and len(ph[0]) == output_size[1]
                        and len(fluo1) == output_size[0]
                        and len(fluo1[0]) == output_size[1]
                        and len(fluo2) == output_size[0]
                        and len(fluo2[0]) == output_size[1]
                    ):
                        cv2.imwrite(f"{temp_dir}/frames/tiff_{k}/Cells/ph/{n}.png", ph)
                        cv2.imwrite(
                            f"{temp_dir}/frames/tiff_{k}/Cells/fluo1/{n}.png", fluo1
                        )
                        cv2.imwrite(
                            f"{temp_dir}/frames/tiff_{k}/Cells/fluo2/{n}.png", fluo2
                        )
                        n += 1

            elif mode == "single_layer":
                for ph in cropped_images_ph:
                    if len(ph) == output_size[0] and len(ph[0]) == output_size[1]:
                        cv2.imwrite(f"{temp_dir}/frames/tiff_{k}/Cells/ph/{n}.png", ph)
                        n += 1
            elif mode == "dual_layer":
                for ph, fluo1 in zip(cropped_images_ph, cropped_images_fluo_1):
                    if len(ph) == output_size[0] and len(ph[0]) == output_size[1]:
                        cv2.imwrite(f"{temp_dir}/frames/tiff_{k}/Cells/ph/{n}.png", ph)
                        cv2.imwrite(
                            f"{temp_dir}/frames/tiff_{k}/Cells/fluo1/{n}.png", fluo1
                        )
                        n += 1
        return num_tiff


class ExtractionCrudBase:
    BULK_INSERT_CHUNK_SIZE: int = 200

    def __init__(
        self,
        nd2_path: str,
        mode: str = "dual_layer",
        param1: int = 130,
        image_size: int = 200,
        reverse_layers: bool = False,
        auto_annotation: bool = False,
        user_id: str | None = None,
        frame_splits: list[FrameSplitConfig] | None = None,
        objective_magnification: ObjectiveMagnification = DEFAULT_OBJECTIVE_MAGNIFICATION,
    ) -> None:
        self.nd2_path = nd2_path
        self.nd2_path = self.nd2_path.replace("\\", "/")
        basename = os.path.basename(self.nd2_path)
        base, _ = os.path.splitext(basename)
        self.nd2_stem = base
        self.file_prefix = base.replace(".", "p")
        self.mode = mode
        self.param1 = param1
        self.image_size = image_size
        self.reverse_layers = reverse_layers
        self.auto_annotation = auto_annotation
        self.ulid = get_ulid()
        self.temp_dir = _get_temp_dir(self.ulid)
        self.user_id = user_id
        self.frame_splits = list(frame_splits or [])
        self.contour_dir = str(EXTRACTED_DATA_DIR / self.nd2_stem)
        self.objective_magnification = objective_magnification
        self.pixel_size_um = pixel_size_for_objective(objective_magnification)

    def load_image(self, path) -> np.ndarray:
        with open(path, "rb") as f:
            data = f.read()
        img_array = np.frombuffer(data, dtype=np.uint8)
        return cv2.imdecode(img_array, cv2.IMREAD_UNCHANGED)

    def process_image(
        self, img_ph, img_fluo1=None, img_fluo2=None
    ) -> tuple[np.ndarray | None, np.ndarray, np.ndarray | None, np.ndarray | None]:
        img_ph_gray = SyncChores.ensure_ph_uint8(img_ph)
        img_fluo1_gray = img_fluo2_gray = None
        if img_fluo1 is not None:
            img_fluo1_gray = SyncChores.preserve_raw_fluorescence_image(
                img_fluo1, "Fluo1"
            )
        if img_fluo2 is not None:
            img_fluo2_gray = SyncChores.preserve_raw_fluorescence_image(
                img_fluo2, "Fluo2"
            )

        _, thresh = cv2.threshold(img_ph_gray, self.param1, 255, cv2.THRESH_BINARY)
        img_canny = cv2.Canny(thresh, 0, 150)
        contours_raw, _ = cv2.findContours(
            img_canny, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        contours = []
        image_center_x = img_ph.shape[1] // 2
        image_center_y = img_ph.shape[0] // 2
        for contour_candidate in contours_raw:
            if cv2.contourArea(contour_candidate) < 300:
                continue
            cx, cy = SyncChores.get_contour_center(contour_candidate)
            if abs(cx - image_center_x) < 3 and abs(cy - image_center_y) < 3:
                contours.append(contour_candidate)
        contour = contours[0] if contours else None
        return contour, img_ph_gray, img_fluo1_gray, img_fluo2_gray

    def process_cell(
        self,
        i: int,
        j: int,
        user_id: str | None = None,
    ) -> Cell | None:
        cell_id = f"F{i}C{j}"
        img_ph = self.load_image(
            f"{self.temp_dir}/frames/tiff_{i}/Cells/ph/{j}.png"
        )
        img_fluo1 = img_fluo2 = None
        if self.mode != "single_layer":
            img_fluo1 = self.load_image(
                f"{self.temp_dir}/frames/tiff_{i}/Cells/fluo1/{j}.png"
            )

        contour, img_ph_gray, img_fluo1_gray, _ = self.process_image(img_ph, img_fluo1)
        if contour is None:
            return None

        perimeter = cv2.arcLength(contour, True)
        area = cv2.contourArea(contour)
        center_x, center_y = SyncChores.get_contour_center(contour)
        if (
            abs(center_x - img_ph.shape[1] // 2) >= 3
            or abs(center_y - img_ph.shape[0] // 2) >= 3
        ):
            return None

        img_ph_data = cv2.imencode(".png", img_ph_gray)[1].tobytes()
        img_fluo1_data = img_fluo2_data = None
        if self.mode != "single_layer":
            img_fluo1_data = cv2.imencode(".png", img_fluo1_gray)[1].tobytes()
        if self.mode in ("triple_layer", "quad_layer"):
            img_fluo2 = self.load_image(
                f"{self.temp_dir}/frames/tiff_{i}/Cells/fluo2/{j}.png"
            )
            img_fluo2_gray = SyncChores.preserve_raw_fluorescence_image(
                img_fluo2, "Fluo2"
            )
            img_fluo2_data = cv2.imencode(".png", img_fluo2_gray)[1].tobytes()
        img_ph_contour = cv2.cvtColor(img_ph_gray, cv2.COLOR_GRAY2BGR)
        cv2.drawContours(img_ph_contour, [contour], -1, (0, 255, 0), 1, cv2.LINE_AA)
        contour_blob = pickle.dumps(contour)
        manual_label: int | str = "N/A"
        if self.auto_annotation:
            manual_label = auto_annotate_cell(
                perimeter=perimeter,
                area=area,
                img_ph=img_ph_data,
                img_fluo1=img_fluo1_data,
                img_fluo2=img_fluo2_data,
                contour_blob=contour_blob,
            )
        cell = Cell(
            cell_id=cell_id,
            label_experiment="",
            manual_label=manual_label,
            perimeter=perimeter,
            area=area,
            img_ph=img_ph_data,
            img_fluo1=img_fluo1_data,
            img_fluo2=img_fluo2_data,
            contour=contour_blob,
            center_x=center_x,
            center_y=center_y,
            user_id=user_id,
            objective_magnification=self.objective_magnification,
            pixel_size_um=self.pixel_size_um,
        )
        return cell

    def _sanitize_db_basename(self, name: str) -> str:
        cleaned = name.strip()
        cleaned = re.sub(r"\.db$", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"[^A-Za-z0-9_\-]", "_", cleaned)
        if not cleaned:
            cleaned = "split"
        stem = re.sub(r"[^A-Za-z0-9_\-]", "_", self.nd2_stem) if self.nd2_stem else ""
        prefix = stem if stem else "nd2file"
        combined = f"{prefix}-{cleaned}"
        combined = re.sub(r"[^A-Za-z0-9_\-]", "_", combined)
        if not combined.lower().endswith(".db"):
            combined = f"{combined}.db"
        return combined

    def _make_unique_basename(
        self, base_name: str, existing: set[str]
    ) -> str:
        candidate = base_name
        counter = 1
        stem, ext = os.path.splitext(base_name)
        while candidate in existing:
            candidate = f"{stem}_{counter}{ext or ''}"
            counter += 1
        existing.add(candidate)
        return candidate

    def _normalize_frame_splits(
        self, frame_count: int, default_db_path: str
    ) -> list[FrameSplitRange]:
        max_frame_index = frame_count - 1 if frame_count > 0 else -1
        normalized: list[FrameSplitRange] = []
        if not self.frame_splits:
            normalized.append(
                FrameSplitRange(
                    frame_start=0,
                    frame_end=max_frame_index,
                    db_name=os.path.basename(default_db_path),
                    db_path=default_db_path,
                )
            )
            return normalized

        existing_names: set[str] = set()
        for cfg in self.frame_splits:
            start = max(0, cfg.frame_start)
            if frame_count > 0 and start > max_frame_index:
                print(
                    f"Split {cfg.frame_start}-{cfg.frame_end} outside available frame range. Skipping."
                )
                continue
            end = cfg.frame_end
            if frame_count > 0:
                end = min(end, max_frame_index)
            if end < start:
                continue
            sanitized = self._sanitize_db_basename(cfg.db_name)
            unique_name = self._make_unique_basename(sanitized, existing_names)
            normalized.append(
                FrameSplitRange(
                    frame_start=start,
                    frame_end=end,
                    db_name=unique_name,
                    db_path=str(DATABASES_DIR / unique_name),
                )
            )

        if not normalized:
            normalized.append(
                FrameSplitRange(
                    frame_start=0,
                    frame_end=max_frame_index,
                    db_name=os.path.basename(default_db_path),
                    db_path=default_db_path,
                )
            )

        normalized.sort(key=lambda split: (split.frame_start, split.frame_end))
        return normalized

    def _reset_database(self, db_path: str) -> None:
        try:
            os.remove(db_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            print(f"Failed to remove existing database {db_path}: {exc}")
        create_database(db_path)

    def _reset_contour_dir(self) -> None:
        contour_path = Path(self.contour_dir)
        if contour_path.exists():
            if contour_path.is_dir():
                shutil.rmtree(contour_path)
            else:
                contour_path.unlink()

    def _populate_database_range(
        self, db_path: str, frame_start: int, frame_end: int
    ) -> int:
        if frame_end < frame_start:
            return 0

        engine = create_engine(
            f"sqlite:///{db_path}",
            echo=False,
            connect_args={"check_same_thread": False, "timeout": 30},
        )
        session_factory = sessionmaker(engine, expire_on_commit=False)
        inserted_count = 0
        pending_cells: list[Cell] = []
        seen_cell_ids: set[str] = set()

        try:
            with session_factory() as session:
                for frame_idx in range(frame_start, frame_end + 1):
                    cell_path = f"{self.temp_dir}/frames/tiff_{frame_idx}/Cells/ph/"
                    if not os.path.exists(cell_path):
                        continue
                    cell_indices = sorted(
                        int(path.stem)
                        for path in Path(cell_path).iterdir()
                        if path.is_file()
                        and path.suffix.lower() == ".png"
                        and path.stem.isdigit()
                    )
                    for j in cell_indices:
                        cell = self.process_cell(frame_idx, j, self.user_id)
                        if cell is None:
                            continue
                        cell_id_str = str(cell.cell_id)
                        if cell_id_str in seen_cell_ids:
                            continue
                        pending_cells.append(cell)
                        seen_cell_ids.add(cell_id_str)
                        if len(pending_cells) >= self.BULK_INSERT_CHUNK_SIZE:
                            session.add_all(pending_cells)
                            session.commit()
                            inserted_count += len(pending_cells)
                            pending_cells.clear()

                if pending_cells:
                    session.add_all(pending_cells)
                    session.commit()
                    inserted_count += len(pending_cells)
                    pending_cells.clear()
        finally:
            engine.dispose()
        return inserted_count

    def main(self) -> tuple[int, str, list[dict[str, int | str]]]:
        chores = SyncChores()
        default_db_path = str(DATABASES_DIR / f"{self.file_prefix}.db")

        self._reset_contour_dir()
        num_tiff = chores.extract_nd2(
            self.nd2_path, self.mode, self.ulid, self.reverse_layers
        )

        chores.init(
            f"{self.file_prefix}.nd2",
            num_tiff,
            self.ulid,
            self.param1,
            self.image_size,
            self.mode,
            contour_dir=self.contour_dir,
        )

        iter_n = {
            "triple_layer": num_tiff // 3,
            "quad_layer": num_tiff // 4,
            "single_layer": num_tiff,
            "dual_layer": num_tiff // 2,
        }

        frame_count = iter_n[self.mode]
        splits = self._normalize_frame_splits(frame_count, default_db_path)
        created_databases: list[dict[str, int | str]] = []

        for split in splits:
            self._reset_database(split.db_path)
            contour_count = self._populate_database_range(
                split.db_path, split.frame_start, split.frame_end
            )
            created_databases.append(
                {
                    "frame_start": split.frame_start,
                    "frame_end": split.frame_end,
                    "db_name": split.db_name,
                    "contour_count": contour_count,
                }
            )

        SyncChores.cleanup(self.temp_dir)
        return num_tiff, self.ulid, created_databases

    def get_nd2_filenames(self) -> list[str]:
        upload_dir = "uploaded_files"
        if not os.path.isdir(upload_dir):
            return []
        return [
            i
            for i in os.listdir(upload_dir)
            if i.endswith(".nd2") and not i.endswith("timelapse.nd2")
        ]

    def delete_nd2_file(self, filename: str) -> bool:
        filename = filename.split("/")[-1]
        os.remove(f"uploaded_files/{filename}")
        return True

    def get_ph_contours(
        self, frame_num: int, nd2_stem: str | None = None
    ) -> StreamingResponse:
        contour_dir = (
            str(EXTRACTED_DATA_DIR / nd2_stem) if nd2_stem else self.contour_dir
        )
        filepath = f"{contour_dir}/{frame_num}.png"
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="File not found")
        return StreamingResponse(open(filepath, "rb"), media_type="image/png")

    def get_ph_contours_num(self, nd2_stem: str | None = None) -> int:
        contour_dir = (
            str(EXTRACTED_DATA_DIR / nd2_stem) if nd2_stem else self.contour_dir
        )
        return len(os.listdir(contour_dir))
