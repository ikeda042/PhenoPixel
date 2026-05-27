# Cell Extraction API

Cell extraction converts ND2 microscopy files into cropped cell images, contour
overlays, and SQLite databases (table `cells`) for downstream analysis.
All routes are served under the backend API prefix: `/api/v1`.

## Base URL

```
http://<host>:<port>/api/v1
```

## Input Files

- Place `.nd2` files in `backend/app/nd2files/`.
- Use the filename only (no paths); only `.nd2` is accepted.
- Dots in filenames are replaced with `p` during processing; use the returned
  `nd2_stem` for output folder names.

## Concurrency

Extraction runs in a background process. The server allows up to
`CELLEXTRACTION_MAX_CONCURRENCY` jobs at a time (default: `2`).

## Endpoints

### Start Extraction

**POST** `/extract-cells`  
Starts an async extraction job.  
Request body (JSON):

```json
{
  "filename": "example.nd2",
  "layer_mode": "dual_layer",
  "param1": 130,
  "image_size": 200
}
```

Parameters:

- `filename` (required): ND2 filename in `backend/app/nd2files/`
- `layer_mode` (required): `single_layer | dual_layer | dual_reversed | triple_layer | quad_layer`
  - accepted aliases: `single`, `dual`, `dual-reversed`, `dual reversed`,
    `triple`, `quad` (case-insensitive)
- `param1` (optional): threshold for binarization, integer >= 0 (default: 130)
- `image_size` (optional): crop size in pixels, integer >= 1 (default: 200)

Response (202):

```json
{ "job_id": "<id>", "status": "running" }
```

### Check Extraction Status

**GET** `/extract-cells/{job_id}`  
Returns job status and result when complete.

Success response (completed):

```json
{
  "job_id": "<id>",
  "status": "completed",
  "result": {
    "num_tiff": 120,
    "ulid": "1234567890123456",
    "databases": [
      {
        "frame_start": 0,
        "frame_end": 59,
        "db_name": "example.db",
        "contour_count": 842
      }
    ],
    "nd2_stem": "example",
    "param1": 130,
    "image_size": 200
  }
}
```

Failure response:

```json
{ "job_id": "<id>", "status": "failed", "error": "Extraction failed" }
```

## Outputs

- Databases: SQLite files written to `backend/app/databases/`.
  - Default name: `<nd2_stem>.db` with dots in the filename replaced by `p`.
  - Table: `cells` (stores `cell_id`, `perimeter`, `area`, `img_ph`, `img_fluo1`,
    `img_fluo2`, `contour`, `center_x`, `center_y`, and labels).
- Contour overlays: PNGs written to `backend/app/extracted_data/<nd2_stem>/`.
  - Files are named by frame index, e.g. `0.png`, `1.png`, `2.png`.

## Related Endpoints (Extracted Data)

These endpoints expose the contour overlay images produced during extraction:

- **GET** `/get-folder-names`  
  Returns extracted folder names.
- **GET** `/get-extracted-image?folder=<nd2_stem>&n=<frame>`  
  Returns a contour overlay PNG.
- **GET** `/get-extracted-image-count?folder=<nd2_stem>`  
  Returns a count of extracted PNGs.

## Example Requests

Start extraction:

```sh
curl -X POST \
  "http://localhost:3000/api/v1/extract-cells" \
  -H "Content-Type: application/json" \
  -d '{"filename":"example.nd2","layer_mode":"dual_layer","param1":130,"image_size":200}'
```

Check status:

```sh
curl "http://localhost:3000/api/v1/extract-cells/<job_id>"
```

Fetch a contour overlay:

```sh
curl -G \
  "http://localhost:3000/api/v1/get-extracted-image" \
  --data-urlencode "folder=example" \
  --data-urlencode "n=0" \
  -o frame0.png
```

## Errors

- `400` invalid input (missing filename, unsupported layer_mode)
- `404` file or job not found
- `429` too many concurrent extraction jobs
- `500` unexpected failure
