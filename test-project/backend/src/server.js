const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const users = [
    { id: 'u-admin-1', email: 'admin@vending.local', password: 'admin123', role: 'admin' },
    { id: 'u-ops-1', email: 'operator@vending.local', password: 'operator123', role: 'operator' }
];

const machines = [
    { id: 'M-001', name: 'Campus Block A', location: 'Ground Floor', status: 'online', heartbeatAt: new Date().toISOString() },
    { id: 'M-002', name: 'Metro Station Gate 2', location: 'Concourse', status: 'online', heartbeatAt: new Date().toISOString() }
];

const products = [
    { id: 'P-101', sku: 'WATER-500', name: 'Mineral Water 500ml', price: 20, image: 'https://picsum.photos/seed/water/120/120' },
    { id: 'P-102', sku: 'COLA-330', name: 'Cola 330ml', price: 40, image: 'https://picsum.photos/seed/cola/120/120' },
    { id: 'P-103', sku: 'CHIPS-40', name: 'Potato Chips 40g', price: 30, image: 'https://picsum.photos/seed/chips/120/120' }
];

const machineStock = [
    { machineId: 'M-001', productId: 'P-101', slot: 'A1', qty: 12 },
    { machineId: 'M-001', productId: 'P-102', slot: 'A2', qty: 8 },
    { machineId: 'M-001', productId: 'P-103', slot: 'A3', qty: 9 },
    { machineId: 'M-002', productId: 'P-101', slot: 'A1', qty: 15 },
    { machineId: 'M-002', productId: 'P-102', slot: 'A2', qty: 7 },
    { machineId: 'M-002', productId: 'P-103', slot: 'A3', qty: 10 }
];

const transactions = [];
const auditLogs = [];

const tokens = new Map();

function nowIso() {
    return new Date().toISOString();
}

function logAudit(event, payload = {}) {
    auditLogs.push({ id: `AUD-${auditLogs.length + 1}`, event, payload, at: nowIso() });
}

function getMachineOr404(machineId, res) {
    const machine = machines.find((m) => m.id === machineId);
    if (!machine) {
        res.status(404).json({ error: 'Machine not found' });
        return null;
    }
    return machine;
}

function auth(requiredRoles = []) {
    return (req, res, next) => {
        const token = req.header('x-auth-token');
        if (!token || !tokens.has(token)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = tokens.get(token);
        if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        req.user = user;
        next();
    };
}

// Health and diagnostics
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'vending-backend',
        timestamp: nowIso(),
        machineCount: machines.length,
        transactionCount: transactions.length
    });
});

// Auth
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = users.find((u) => u.email === email && u.password === password);

    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = `tok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeUser = { id: user.id, email: user.email, role: user.role };
    tokens.set(token, safeUser);
    logAudit('auth.login', { userId: user.id, role: user.role });

    res.json({ token, user: safeUser });
});

// Customer APIs
app.get('/api/machines', (req, res) => {
    res.json({ machines });
});

app.get('/api/machines/:machineId/products', (req, res) => {
    const machine = getMachineOr404(req.params.machineId, res);
    if (!machine) return;

    const rows = machineStock
        .filter((s) => s.machineId === machine.id)
        .map((s) => {
            const product = products.find((p) => p.id === s.productId);
            return {
                machineId: machine.id,
                slot: s.slot,
                qty: s.qty,
                product
            };
        });

    res.json({ machine, items: rows });
});

app.get('/api/machines/:machineId/stock', (req, res) => {
    const machine = getMachineOr404(req.params.machineId, res);
    if (!machine) return;

    const stock = machineStock.filter((s) => s.machineId === machine.id);
    res.json({ machineId: machine.id, stock });
});

app.post('/api/transactions/initiate', (req, res) => {
    const { machineId, productId } = req.body || {};
    if (!machineId || !productId) {
        return res.status(400).json({ error: 'machineId and productId are required' });
    }

    const machine = machines.find((m) => m.id === machineId);
    if (!machine) {
        return res.status(404).json({ error: 'Machine not found' });
    }

    const product = products.find((p) => p.id === productId);
    if (!product) {
        return res.status(404).json({ error: 'Product not found' });
    }

    const stockRow = machineStock.find((s) => s.machineId === machineId && s.productId === productId);
    if (!stockRow || stockRow.qty < 1) {
        return res.status(409).json({ error: 'Out of stock' });
    }

    const tx = {
        id: `TX-${Date.now()}`,
        machineId,
        productId,
        amount: product.price,
        status: 'initiated',
        paymentRef: `PAY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        dispensedAt: null
    };

    transactions.push(tx);
    logAudit('transaction.initiated', { transactionId: tx.id, machineId, productId });
    res.status(201).json({ transaction: tx });
});

app.post('/api/payments/verify', (req, res) => {
    const { transactionId, success } = req.body || {};
    const tx = transactions.find((t) => t.id === transactionId);

    if (!tx) {
        return res.status(404).json({ error: 'Transaction not found' });
    }

    tx.status = success === false ? 'payment_failed' : 'paid';
    tx.updatedAt = nowIso();
    logAudit('payment.verify', { transactionId: tx.id, status: tx.status });

    res.json({ transaction: tx });
});

app.post('/api/machines/:machineId/dispense', (req, res) => {
    const { transactionId } = req.body || {};
    const machineId = req.params.machineId;

    const machine = getMachineOr404(machineId, res);
    if (!machine) return;

    const tx = transactions.find((t) => t.id === transactionId && t.machineId === machineId);
    if (!tx) {
        return res.status(404).json({ error: 'Transaction not found for machine' });
    }

    if (tx.status !== 'paid') {
        return res.status(409).json({ error: 'Transaction is not paid' });
    }

    const stockRow = machineStock.find((s) => s.machineId === machineId && s.productId === tx.productId);
    if (!stockRow || stockRow.qty < 1) {
        tx.status = 'failed';
        tx.updatedAt = nowIso();
        logAudit('dispense.failed', { transactionId: tx.id, reason: 'out_of_stock' });
        return res.status(409).json({ error: 'Cannot dispense. Out of stock.' });
    }

    stockRow.qty -= 1;
    tx.status = 'dispensed';
    tx.dispensedAt = nowIso();
    tx.updatedAt = nowIso();
    logAudit('dispense.success', { transactionId: tx.id, machineId, remainingQty: stockRow.qty });

    res.json({ transaction: tx, stock: stockRow, machine });
});

app.get('/api/transactions/:id', (req, res) => {
    const tx = transactions.find((t) => t.id === req.params.id);
    if (!tx) {
        return res.status(404).json({ error: 'Transaction not found' });
    }
    res.json({ transaction: tx });
});

// Admin/operator APIs
app.get('/api/admin/machines', auth(['admin', 'operator']), (req, res) => {
    const withCounts = machines.map((m) => {
        const items = machineStock.filter((s) => s.machineId === m.id);
        const totalUnits = items.reduce((sum, s) => sum + s.qty, 0);
        return { ...m, totalUnits, lowStock: items.filter((s) => s.qty <= 3).length };
    });

    res.json({ machines: withCounts });
});

app.put('/api/admin/machines/:machineId/stock', auth(['admin', 'operator']), (req, res) => {
    const { productId, qty } = req.body || {};
    const machineId = req.params.machineId;

    if (!productId || typeof qty !== 'number' || qty < 0) {
        return res.status(400).json({ error: 'productId and non-negative qty are required' });
    }

    const machine = getMachineOr404(machineId, res);
    if (!machine) return;

    const row = machineStock.find((s) => s.machineId === machineId && s.productId === productId);
    if (!row) {
        return res.status(404).json({ error: 'Stock row not found' });
    }

    row.qty = qty;
    logAudit('stock.updated', { machineId, productId, qty, by: req.user.id });
    res.json({ stock: row });
});

app.get('/api/admin/transactions', auth(['admin', 'operator']), (req, res) => {
    res.json({ transactions: transactions.slice().reverse().slice(0, 100) });
});

app.get('/api/admin/audit-logs', auth(['admin']), (req, res) => {
    res.json({ logs: auditLogs.slice().reverse().slice(0, 200) });
});

app.listen(PORT, () => {
    console.log(`Vending backend running on http://localhost:${PORT}`);
});

module.exports = app;
