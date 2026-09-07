# CityLens AI — SIH Production Release

This package includes the production-hardening work requested for the SIH build:

- HttpOnly cookie authentication with session restoration and RBAC enforcement.
- Signup/login validation, duplicate-account handling, logout and session revocation support.
- Neon PostgreSQL production persistence with local JSON fallback for development.
- Vercel serverless entrypoint and deployment configuration.
- Persistent evidence/object-storage adapter for Vercel Blob.
- Liquid-glass dark UI, light/system mode and configurable accent themes.
- Impact Journey, Before/After repair comparison, Judge Mode and System Status views.
- Honest empty/unconfigured states instead of fabricated operational values.
- Optional explicitly-labelled demo dataset for SIH walkthroughs.
- Edge/field workflow with offline queue support.
- Static checks and isolated HTTP integration tests.

## Before production deployment
1. Run `npm install`.
2. Configure `DATABASE_URL` and a strong stable `AUTH_SECRET` in Vercel.
3. Connect a Vercel Blob store for persistent uploads/evidence.
4. Optionally set `YOLO_SERVICE_URL` for an external YOLO inference service.
5. Run `npm run migrate` and then deploy.

See `README.md` and `docs/DEPLOYMENT.md` for details.
