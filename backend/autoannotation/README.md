# Auto Annotation Assets

This folder contains the supervised auto-annotation model used by Cell
Extraction when `auto_annotation=true`.

## Files

- `artifacts/autoannotator.pkl`: bundled supervised annotator.
- `artifacts/evaluation.json`: training and cross-validation summary.
- `testdata/autoannotation_testdata.db`: single reference SQLite training
  dataset used for the bundled model.

## Reference Dataset

`testdata/autoannotation_testdata.db` contains 520 labeled cells in the
PhenoPixel `cells` table format:

- `manual_label = 1`: 300 cells
- `manual_label = N/A`: 220 cells
- source DBs: `microscope_data.db` (289 cells) and `test_database (1).db`
  (231 cells)

The merged table keeps provenance columns:

- `source_db`: original database filename.
- `source_cell_id`: original `cell_id` from that database.
- `cell_id`: source-prefixed ID to avoid collisions in the merged dataset.

Quick checks:

```sh
sqlite3 backend/autoannotation/testdata/autoannotation_testdata.db \
  "SELECT manual_label, COUNT(*) FROM cells GROUP BY manual_label;"

sqlite3 backend/autoannotation/testdata/autoannotation_testdata.db \
  "SELECT source_db, COUNT(*) FROM cells GROUP BY source_db;"
```
