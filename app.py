#!/usr/bin/env python3
"""Web interface for glass2svg — upload a drawing, get a cut-ready SVG."""
import pathlib

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import glass2svg

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
STATIC = pathlib.Path(__file__).parent / "static"

app = FastAPI(title="glass2svg")


@app.middleware("http")
async def revalidate(request, call_next):
    # The UI is a single evolving page; without this Cloudflare caches
    # index.html/editor.js by extension and serves a stale build after a
    # deploy (the LAN IP looks fine because it bypasses the edge). "no-cache"
    # keeps the asset cacheable but forces revalidation against the origin,
    # so a new version always comes through (ETag makes the check a cheap 304).
    resp = await call_next(request)
    resp.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
    return resp


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/convert")
async def convert(
    image: UploadFile = File(...),
    mode: str = Form("pieces"),
    threshold: int = Form(95),
    auto_threshold: bool = Form(False),
    simplify: float = Form(0.15),
    sigma: float = Form(1.5),
    straighten: float = Form(2.2),
    min_run: float = Form(15),
    min_area: float = Form(100),
    min_width: float = Form(3.0),
    grow: float = Form(0.5),
    close: int = Form(1),
    invert: bool = Form(False),
):
    data = await image.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "image too large (20 MB max)")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise HTTPException(400, "could not decode image — upload a PNG/JPG")
    if mode not in ("pieces", "lines"):
        raise HTTPException(400, "mode must be 'pieces' or 'lines'")

    svg, count = glass2svg.convert(
        img,
        mode=mode,
        threshold=None if auto_threshold else max(0, min(255, threshold)),
        simplify=max(0.0, simplify),
        sigma=max(0.0, sigma),
        straighten=max(0.0, straighten),
        min_run=max(0.0, min_run),
        min_area=max(0.0, min_area),
        min_width=max(0.0, min_width),
        grow=max(0.0, grow),
        close=max(0, min(10, close)),
        invert=invert,
    )
    if count == 0:
        raise HTTPException(
            422, "no line-work detected — try adjusting the threshold")
    h, w = img.shape
    return JSONResponse({"svg": svg, "count": count, "width": w, "height": h})
