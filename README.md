# Tekhouz Warehouse Management System

A full-featured warehouse management web app for tracking refurbished devices — purchase orders, inventory, testing, grading, and order fulfilment.

## Features
- 📦 Purchase Order management with receive workflow
- 🏷 Inventory tracking with barcode label printing
- 🔬 Device testing & grading (A/B/C/D + MDM/Lock status)
- 📋 Daily Orders with barcode scan-to-assign serial numbers
- 📊 Dashboard with KPIs, period filters, and custom date ranges
- ⚙️ Catalog settings (Colors, RAM, Storage, Models per brand)
- 👥 User management with role-based access

## Quick Start
```bash
cp .env.example .env
# Edit .env and set a secure JWT_SECRET
npm install
npm start
```
Open http://localhost:3000 — default login: `admin / admin123`

## Tech Stack
- **Backend:** Node.js, Express, better-sqlite3
- **Frontend:** Vanilla JS SPA, no framework
- **Auth:** JWT (12h expiry)
- **Exports:** SheetJS (XLSX)
- **Labels:** JsBarcode (Code128)

## Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret key for JWT signing | (required in production) |
| `PORT` | HTTP port | `3000` |
| `NODE_ENV` | `production` or `development` | `development` |

## Deployment
Works on any Node.js host (Railway, Render, DigitalOcean, VPS). SQLite database stored as `refurb.db` — ensure the file path is persisted (use a volume in containerised deployments).
