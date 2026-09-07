# CityLens AI v3

**AI-Powered Buses as Mobile City Scanners** — an SIH-ready urban intelligence and civic operations platform.

CityLens converts bus/field camera observations into geo-tagged detections, merges repeated observations into civic incidents, prioritises them by impact, routes work through department/SLA tickets, records repair evidence, and closes the loop through post-repair re-observation.

## What is new in v3
- Production-stable **HttpOnly cookie authentication**; no browser localStorage bearer token.
- **Neon PostgreSQL** persistence path for Vercel/serverless deployments.
- **Private Vercel Blob** persistence path for uploads and repair evidence, served through authenticated short-lived signed URLs.
- Dark-first premium **Liquid Glass** command centre with persisted accent themes.
- **Impact Journey** showing stored incident/ticket/evidence events end-to-end.
- **Before/After** repair comparison when both evidence images exist.
- Guided **SIH Judge Mode** that opens real modules and displays real stored values.
- **System Status Centre** that reports Database/Storage/Auth/Realtime/YOLO states honestly.
- Optional explicitly labelled **Demo Dataset** (`npm run seed:demo`).
- Vercel serverless entrypoint and deployment configuration.

## Quick start
```bash
npm install
cp .env.example .env
npm run dev
```
Open `http://localhost:4000/app`.

Seeded known-password accounts exist only in local development. Production creates no default users; set `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` for the first admin. Public sign-up always creates a read-only analyst account.

## Production environment
Required on Vercel:
```text
DATABASE_URL=...
AUTH_SECRET=...
```
Connect a **Private Vercel Blob** store for persistent evidence. Current Vercel projects can authenticate Blob with OIDC; `BLOB_READ_WRITE_TOKEN` remains supported for legacy/static-token setups. Optional:
```text
YOLO_SERVICE_URL=...
```

Run `npm run migrate` for the Neon runtime tables. The app also creates these tables idempotently at startup.

## Demo mode
```bash
npm run seed:demo
```
This inserts one coherent pothole workflow solely for SIH presentation. Every operational record is labelled `Demo Dataset`; no demo records are inserted automatically.

## Main folders
- `public/` — landing page, command centre SPA and field/edge client.
- `src/` — API/domain engines, auth, persistence, AI analysis and storage.
- `api/index.js` — Vercel serverless entrypoint.
- `migrations/` — Neon runtime migration.
- `schema.sql` — normalized PostgreSQL reference schema.
- `docs/` — architecture, API, deployment, testing and demo documentation.

## Reliability principles
Real data > impressive fake numbers. Missing services remain visibly unconfigured. Authentication failures are distinct from permission errors. Vercel production does not depend on local filesystem persistence or per-instance random secrets.

## Verification commands
```bash
npm run check
npm run test:integration   # use local/disposable data
```
