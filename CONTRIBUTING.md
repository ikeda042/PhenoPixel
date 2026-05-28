# Contributing to PhenoPixel

Thanks for your interest in improving PhenoPixel. This project is a microscopy
cell-extraction and batch-analytics pipeline (FastAPI backend + React/Vite frontend),
and contributions of every size are welcome — from typo fixes to new analysis modes.

## Ways to contribute

- **Report a bug** — open an issue using the *Bug report* template.
- **Request a feature** — open an issue using the *Feature request* template.
- **Ask a question** — use the *Question* template (or GitHub Discussions if enabled).
- **Improve docs** — README, method notes, screenshots, translations.
- **Submit a pull request** — bug fixes, new analysis modes, frontend improvements.
- **Share a use case** — let us know if you used PhenoPixel in a paper or course;
  we may feature it in the README.

## Development setup

### Prerequisites

- Python 3.x (Launch uses `python3.14`)
- Node.js with npm
- SQLite

### Backend

```sh
python3.14 -m venv venv
source ./venv/bin/activate
cd backend
pip install -r requirements.txt
python main.py
```

Backend runs at `http://localhost:3000` (API base: `/api/v1`,
Swagger UI: `/api/v1/docs`).

### Frontend

```sh
cd frontend
npm install
npm run dev
```

Frontend dev server runs at `http://localhost:3001`.

### Docker (Traefik)

For an end-to-end deploy, see the *Docker Deploy* section of the
[README](README.md).

## Project layout

```
backend/
  app/                # API routers, extraction, bulk engine, etc.
  main.py             # FastAPI entrypoint
  requirements.txt
  tests/
docker/               # compose + Traefik config
docs/                 # screenshots, screen recordings, method images
frontend/
  src/                # React + TypeScript source
  package.json
```

Module-specific READMEs:

- [Bulk Engine API](backend/app/bulk_engine/README.md)
- [Cell Extraction API](backend/app/cellextraction/README.md)
- [Frontend](frontend/README.md)

## Pull request workflow

1. **Fork** the repo and create a topic branch from `main`:
   `git checkout -b feat/<short-name>` or `fix/<short-name>`.
2. **Make focused changes.** Keep one PR scoped to one logical change so it can
   be reviewed and reverted independently.
3. **Verify locally** before pushing:
   - Backend: run the affected endpoints, or `pytest backend/tests` if relevant.
   - Frontend: `npm run build` and `npm run lint` should pass.
4. **Update docs** when behavior or API surface changes (README, module READMEs,
   screenshots).
5. **Open a pull request** against `main`. Fill in the PR template — *what*,
   *why*, and *how it was tested*. Link any related issue (`Closes #123`).
6. **Iterate on review.** Push additional commits; we squash-merge on accept.

## Contribution licensing

By submitting a contribution, you agree that your contribution is licensed
under the same MIT License that covers PhenoPixel.

## Coding guidelines

### Python (backend)

- Target Python 3.x compatible with `requirements.txt`.
- Type hints encouraged on public functions and Pydantic models.
- Keep image-processing routines pure where possible: take arrays/contours in,
  return arrays/scalars out — easier to test and reuse from the bulk engine.
- New numerical routines should be documented with the underlying formula
  (a short LaTeX block in the module README is great).

### TypeScript / React (frontend)

- TypeScript strictness follows the existing `tsconfig.app.json`.
- Components live under `frontend/src/`; prefer small, presentational components
  with state lifted to the page level.
- ESLint must pass: `npm run lint`.

### Commits

- Imperative mood: `add bulk-engine entropy mode`, `fix off-by-one in centerline arc length`.
- Reference issues when applicable: `Closes #42`.
- Small, atomic commits are preferred over one giant commit per PR.

## Reporting bugs

A good bug report includes:

- PhenoPixel version / commit SHA
- OS and browser (for frontend issues)
- Backend logs around the failure (`uvicorn` stderr)
- A minimal ND2 file or steps to reproduce, if data-dependent
- What you expected vs. what happened, and a screenshot if visual

The *Bug report* issue template walks you through these fields.

## Proposing new analysis modes

PhenoPixel's bulk engine is intentionally extensible. If you're adding a new
mode (e.g., a new shape descriptor or a fluorescence summary):

1. Open a *Feature request* issue first to discuss the math and the expected
   output (scalar per cell, vector per cell, plot, JSON export, …).
2. Add the implementation under
   [backend/app/bulk_engine/](backend/app/bulk_engine/) and wire it into the
   mode dispatcher.
3. Document the formula in the bulk engine README so future users know what
   the number means.
4. Add a screenshot to `docs/screenshots/` if the mode produces a plot.

## Citing PhenoPixel

If PhenoPixel was useful in a paper, course, or thesis, please cite it using
the `CITATION.cff` in the repo root (visible from GitHub's "Cite this repository"
button) or the DOI badge in the README. Letting us know also helps — open an
issue or PR adding your work to a "Used in" list.

## Code of conduct

Be respectful. Assume good faith. Critique code, not people. Maintainers may
remove comments or close issues that violate this in spirit.

## Questions

Not sure where to start? Open an issue with the *Question* template, and we'll
point you to the right place.
