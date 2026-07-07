"""Smoke tests over a synthetic stained-glass drawing.

The fixture draws a 3x2 grid of cells with thick black lines — the simplest
image whose conversion exercises the full pipeline: thresholding, piece
extraction, straightening, and SVG generation.
"""
import re

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import glass2svg
from app import app


@pytest.fixture
def grid_image():
    img = np.full((300, 450), 230, np.uint8)
    for x in (0, 150, 300, 449):
        cv2.line(img, (x, 0), (x, 299), (0,), 7)
    for y in (0, 150, 299):
        cv2.line(img, (0, y), (449, y), (0,), 7)
    return img


def test_pieces_mode_finds_every_cell(grid_image):
    svg, count = glass2svg.convert(grid_image, mode="pieces")
    assert count == 6                       # 3x2 grid
    assert svg.count("<path") == 6
    assert 'id="piece-1"' in svg


def test_lines_mode_single_web(grid_image):
    svg, count = glass2svg.convert(grid_image, mode="lines")
    assert count == 1                       # all lines connected
    assert "<path" in svg


def test_straightening_emits_lines_not_curves(grid_image):
    svg, _ = glass2svg.convert(grid_image, mode="pieces")
    # a grid of straight boxes should straighten almost entirely
    n_lines = len(re.findall(r"L", svg))
    n_curves = len(re.findall(r"C", svg))
    assert n_lines > n_curves


def test_blank_image_yields_nothing():
    blank = np.full((100, 100), 255, np.uint8)
    _, count = glass2svg.convert(blank, mode="pieces")
    assert count == 0


def test_http_convert_roundtrip(grid_image):
    ok, buf = cv2.imencode(".png", grid_image)
    assert ok
    client = TestClient(app)
    res = client.post(
        "/convert",
        files={"image": ("grid.png", buf.tobytes(), "image/png")},
        data={"mode": "pieces"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 6
    assert body["svg"].startswith("<svg")
    assert body["width"] == 450 and body["height"] == 300


def test_http_rejects_garbage():
    client = TestClient(app)
    res = client.post(
        "/convert",
        files={"image": ("nope.png", b"not an image", "image/png")},
    )
    assert res.status_code == 400
