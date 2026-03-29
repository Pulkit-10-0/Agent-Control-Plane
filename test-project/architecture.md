# ARCHITECTURE

## System Overview
Vending platform with a customer purchase flow and an admin/operator operations flow.
The system is machine-centric: every inventory and transaction operation is scoped by machine ID.

## Frontend Layer
- Customer Web/PWA:
  - View products for a selected machine.
  - Start UPI payment and track status.
  - Show dispense result and transaction reference.
- Admin/Operator Dashboard:
  - View machine health/status (polling in MVP).
  - Refill/update machine stock.
  - Monitor recent transactions and failures.

## Backend Layer
- API style: stateless REST endpoints with machine-aware routing.
- Core modules:
  - Machine service (status, listing, heartbeat).
  - Inventory service (slot-level stock read/update).
  - Payment service (UPI gateway adapter + verification).
  - Dispense service (simulated hardware adapter, pluggable for real device).
  - Transaction service (state machine: initiated -> paid -> dispensed/failed).
- Auth:
  - Admin/operator login with role checks.
  - Customer endpoints public for MVP.

## Data Layer
- Primary choice: MongoDB Atlas or PostgreSQL.
- Key entities:
  - users
  - machines
  - products
  - machine_stock
  - transactions
  - audit_logs

## Hardware and External Integrations
- Payment gateway integration (UPI-first) through adapter interface.
- Dispenser controller integration through abstraction:
  - MVP: simulator endpoint/module.
  - Phase 2: real Arduino/Raspberry Pi bridge.

## Deployment Approach
- Frontend: Vercel.
- Backend: Render/Railway/EC2-compatible Node deployment.
- Database: managed cloud DB.
- Observability: trace/performance files in current project loop, extend to hosted logs later.

## Scalability Strategy
- Pilot-first (1-10 machines) with 100+ machine-ready model.
- Stateless APIs and machine partitioning by `machineId`.
- Replace polling with WebSocket/MQTT when scale requires real-time fanout.

## Agent/AI Execution Layer
- agentRunner consumes CONTEXT + instructions + skill files.
- watcher observes logs/traces/perf and triggers analysis.
- parser builds prompt context for diagnostics.
- geminiClient writes recommendations to `GEMINI/src/output.md`.
- Feedback loop enforces correction when implementation drifts from context.
