# Mother Machine pipeline

This module is isolated from the standard PhenoPixel extraction flow.

## Storage

- `app/mother-machine-nd2files/`: uploaded ND2 files
- `app/mother-machine-databases/<nd2-stem>.db`: one SQLite database per ND2
- `app/mother-machine-results/<nd2-stem>/`: raw and overlay ROI review images

Each row in the `cells` table represents one cell instance at one
`view_index` / `roi_id` / `time_frame`. The ROI is a mother-machine channel.
The composite index on those three columns supports the review UI queries.

## Extraction

`processor.py` ports the `mothermachine-poc/smallchannel` flow:

1. map the fixed 16-bit range to 8-bit;
2. apply the configured channel rectangles for ND2 P indices 1, 2, and 3;
3. track XY drift from the reference frame;
4. run Cellpose's `cpsam_v2` model over each horizontal channel band;
5. apply shape, intensity, containment, and temporal-recovery filters;
6. save cell records plus raw/overlay crops for each channel and time frame.

All ND2 fields remain present in the manifest so the frontend page count always
matches the ND2 field count. Fields without a channel definition are marked as
unconfigured instead of being silently omitted. Add future layouts to
`channel_config.json` using zero-based ND2 P indices.

Published results are replaced only after both the new result tree and SQLite
database have been completed successfully.
