# Step 3 — Connections Service (FastAPI + SQL Server)

This bundle adds/updates only the files required for **Connections Service**.

## What’s included
- Alembic migration: `backend/alembic/versions/20250922_0003_connections.py`
- Backend service: `backend/app/connections_service/` (models, schemas, routers, main, service helper)
- Secret provider abstraction: `backend/app/common/secret_provider.py`
- Updated Alembic env to import connections models: `backend/alembic/env.py`
- Frontend additions: `frontend/src/api/connections.ts`, `frontend/src/pages/Connections.tsx`, updated `frontend/src/App.tsx`
- VS Code: updated `.vscode/launch.json` with a Connections Service run config

## Apply
1) Extract this zip **into your repo root** `ETL-ELT-MVP` (merge/overwrite).
2) Run migration:
   ```bat
   cd backend
   alembic -c alembic.ini upgrade head
   ```
3) Start Connections service:
   ```bat
   uvicorn app.connections_service.main:app --host 127.0.0.1 --port 8003 --reload
   ```
4) Set your secret in env (example):
   - CMD: `set SECRET_CONN_SQL1=Aa@112334556`
   - PowerShell: `$env:SECRET_CONN_SQL1="Aa@112334556"`
5) Create & test via curl:
   ```bat
   :: login to get <ACCESS_TOKEN> on 8001 first

   :: create
   curl -X POST http://127.0.0.1:8003/connections -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" -d "{"name":"SQL Local","kind":"mssql","server":"SSIS-TESTENV\\SSISTESTDB","database":"etl_meta","auth":"sql","username":"test","secret_ref":"SECRET_CONN_SQL1","options":{"TrustServerCertificate":"yes"}}"

   :: test
   curl -X POST http://127.0.0.1:8003/connections/1/test -H "Authorization: Bearer <ACCESS_TOKEN>"
   ```
