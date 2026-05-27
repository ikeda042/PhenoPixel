# PhenoPixel Frontend

React + Vite UI for PhenoPixel. The app talks to the backend API under
`/api/v1` and is built to be served either standalone in dev or by the backend
in production.

## Requirements

- Node.js with npm
- Backend running for API access (defaults to port 3000)

## Setup

```sh
cd frontend
npm install
```

## Development

```sh
npm run dev
```

- Dev server: http://localhost:3001
- API base default (dev): `http://<host>:3000/api/v1`

### API Base Override

Set `VITE_API_BASE` to point to a different backend. You can include or omit
`/api/v1`; it is added automatically if missing.

```sh
VITE_API_BASE=http://localhost:3000 npm run dev
```

Restart the dev server after changing env vars.

## Build

```sh
npm run build
```

Outputs to `frontend/dist`. The backend serves these static assets when the
folder exists (see `backend/main.py`).

## Preview

```sh
npm run preview
```

## Lint

```sh
npm run lint
```

## Project Layout

- `frontend/src/pages` routes and page-level views
- `frontend/src/components` shared UI components
- `frontend/src/utils/apiBase.ts` API base resolution logic
- `frontend/src/theme.ts` Chakra theme configuration
