# INSTRUCTIONS

1. Define vending domain models:
   - Machine (id, name, location, status, heartbeatAt)
   - Product (id, sku, name, price, image)
   - MachineStock (machineId, productId, slot, qty)
   - Transaction (id, machineId, productId, amount, status, paymentRef, dispensedAt)
   - User (id, email, passwordHash, role)

2. Build backend APIs (MVP):
   - GET /api/machines
   - GET /api/machines/:machineId/products
   - GET /api/machines/:machineId/stock
   - POST /api/transactions/initiate
   - POST /api/payments/verify
   - POST /api/machines/:machineId/dispense
   - GET /api/transactions/:id
   - GET /api/admin/machines
   - PUT /api/admin/machines/:machineId/stock
   - GET /api/admin/transactions

3. Implement auth and RBAC:
   - Admin/operator login endpoint.
   - Role checks for admin/operator routes.
   - Customer routes public for MVP.

4. Build frontend apps:
   - Customer PWA page: machine product list and pay flow.
   - Payment status screen: success/failure and dispense status.
   - Admin/operator dashboard: machine status, stock update, recent transactions.

5. Integrate payment and hardware abstractions:
   - UPI-first gateway adapter interface.
   - Simulated dispenser adapter (replaceable with real device integration).
   - Ensure transaction state transitions are consistent.

6. Add telemetry and diagnostics:
   - Write audit events for payment, dispense, stock update, and failures.
   - Keep watcher and parser tracing active.

7. Validate and correct from context:
   - If generated APIs or routes diverge from CONTEXT.md, fix existing files.
   - Prefer editing and correcting over creating duplicate implementations.

8. Run loop commands:
   - node backend/src/agentRunner.js
   - node backend/src/watcher.js

9. Keep runtime evidence updated:
   - traces/session_log/logs.txt
   - traces/session_log/agent_trace.txt
   - traces/performance/memory.txt
   - traces/performance/latency.txt
   - GEMINI/src/output.md
