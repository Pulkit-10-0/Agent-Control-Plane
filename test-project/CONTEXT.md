# CONTEXT

Project idea: Build a vending machine management and purchase system.

## MVP Goals
- Customer can view machine products, select an item, and pay with UPI.
- Successful payment triggers dispense event and reduces machine stock.
- System records transaction and exposes audit trail.

## Core MVP Features
- Product selection UI and backend logic.
- UPI-first payment flow (gateway integration abstraction).
- Per-machine stock tracking with machine IDs.
- Basic machine health/status visibility (polling-based).

## Phase 2 Features
- Digital receipts.
- Refill management dashboard enhancements.
- Advanced maintenance diagnostics.

## User Roles
- Customer: browse/select item, pay, view purchase result.
- Operator: refill stock, view machine status, handle simple maintenance actions.
- Admin: full access to machines, products, pricing, and analytics.

## Platform
- Customer-facing responsive web app/PWA.
- Admin/operator web dashboard.

## Scale and Constraints
- Initial pilot: 1 to 10 machines.
- Architecture must scale to 100+ machines.
- Backend APIs must be stateless and machine-aware.
- Use machine IDs consistently in all stock and transaction operations.

## Authentication
- Customer: no login or OTP (optional later).
- Admin/operator: email/password with role-based authorization.

## Integrations
- Payment gateway required (UPI-first).
- Dispenser controller integration required (simulated first, real hardware later).
- Backend-machine communication via HTTP/WebSocket abstraction.

## Deployment Target
- Frontend: Vercel.
- Backend: Render/Railway/EC2-compatible Node runtime.
- Database: MongoDB Atlas or PostgreSQL.

## Non-Goals For MVP
- Native mobile app.
- Complex OAuth and enterprise SSO.
- Full IoT sensor network and SMS automation.

## Last Copilot Edit
- File: frontend\public\app.js
- Line: 1
- Time: 2026-03-29T10:15:23.809Z
- Step: 72
