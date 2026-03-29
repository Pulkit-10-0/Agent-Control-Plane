const API_URL = 'http://localhost:3001/api';

const machineSelect = document.getElementById('machine-select');
const productList = document.getElementById('product-list');
const customerStatus = document.getElementById('customer-status');
const txResult = document.getElementById('tx-result');

const adminEmail = document.getElementById('admin-email');
const adminPassword = document.getElementById('admin-password');
const adminLoginBtn = document.getElementById('admin-login-btn');
const adminStatus = document.getElementById('admin-status');
const machineTable = document.getElementById('machine-table');
const txTable = document.getElementById('tx-table');

let selectedMachine = null;
let adminToken = '';

document.addEventListener('DOMContentLoaded', async () => {
    await loadMachines();
    adminLoginBtn.addEventListener('click', adminLogin);
});

async function api(path, options = {}) {
    const res = await fetch(`${API_URL}${path}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function loadMachines() {
    try {
        const data = await api('/machines');
        machineSelect.innerHTML = data.machines
            .map((m) => `<option value="${m.id}">${m.id} - ${m.name}</option>`)
            .join('');

        selectedMachine = data.machines[0]?.id || null;
        machineSelect.addEventListener('change', async (e) => {
            selectedMachine = e.target.value;
            await loadProductsForMachine();
        });

        await loadProductsForMachine();
        setText(customerStatus, 'Customer kiosk ready.');
    } catch (err) {
        setText(customerStatus, `Machine load failed: ${err.message}`);
    }
}

async function loadProductsForMachine() {
    if (!selectedMachine) {
        productList.innerHTML = '<div class="empty">No machine available.</div>';
        return;
    }

    try {
        const data = await api(`/machines/${selectedMachine}/products`);
        if (!data.items.length) {
            productList.innerHTML = '<div class="empty">No products found for this machine.</div>';
            return;
        }

        productList.innerHTML = data.items
            .map((item) => {
                const disabled = item.qty < 1 ? 'disabled' : '';
                const buttonLabel = item.qty < 1 ? 'Out of stock' : 'Pay & Dispense';
                return `
                    <div class="product-card">
                        <div class="top-row">
                            <strong>${escapeHtml(item.product.name)}</strong>
                            <span>Slot ${item.slot}</span>
                        </div>
                        <div class="meta">
                            <span>Price: INR ${item.product.price}</span>
                            <span>Stock: ${item.qty}</span>
                        </div>
                        <button ${disabled} onclick="startPurchase('${item.product.id}')">${buttonLabel}</button>
                    </div>
                `;
            })
            .join('');
    } catch (err) {
        productList.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
}

async function startPurchase(productId) {
    try {
        setText(customerStatus, 'Initiating payment...');

        const initData = await api('/transactions/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ machineId: selectedMachine, productId })
        });

        const tx = initData.transaction;
        setText(customerStatus, `UPI payment reference: ${tx.paymentRef}. Verifying...`);

        const paymentData = await api('/payments/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionId: tx.id, success: true })
        });

        if (paymentData.transaction.status !== 'paid') {
            throw new Error('Payment was not successful');
        }

        const dispenseData = await api(`/machines/${selectedMachine}/dispense`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionId: tx.id })
        });

        const result = dispenseData.transaction;
        txResult.innerHTML = `
            <div class="success-box">
                <div><strong>Transaction:</strong> ${escapeHtml(result.id)}</div>
                <div><strong>Status:</strong> ${escapeHtml(result.status)}</div>
                <div><strong>Dispensed At:</strong> ${escapeHtml(result.dispensedAt || '-')}</div>
            </div>
        `;

        setText(customerStatus, 'Payment successful. Item dispensed.');
        await loadProductsForMachine();
        if (adminToken) {
            await loadAdminData();
        }
    } catch (err) {
        setText(customerStatus, `Purchase failed: ${err.message}`);
    }
}

async function adminLogin() {
    try {
        const data = await api('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: adminEmail.value.trim(),
                password: adminPassword.value.trim()
            })
        });

        adminToken = data.token;
        setText(adminStatus, `Logged in as ${data.user.role}: ${data.user.email}`);
        await loadAdminData();
    } catch (err) {
        setText(adminStatus, `Login failed: ${err.message}`);
    }
}

async function loadAdminData() {
    await Promise.all([loadAdminMachines(), loadAdminTransactions()]);
}

async function loadAdminMachines() {
    try {
        const data = await api('/admin/machines', {
            headers: { 'x-auth-token': adminToken }
        });

        machineTable.innerHTML = data.machines
            .map((m) => `
                <tr>
                    <td>${escapeHtml(m.id)}</td>
                    <td>${escapeHtml(m.name)}</td>
                    <td>${escapeHtml(m.status)}</td>
                    <td>${m.totalUnits}</td>
                    <td>${m.lowStock}</td>
                </tr>
            `)
            .join('');
    } catch (err) {
        machineTable.innerHTML = `<tr><td colspan="5">${escapeHtml(err.message)}</td></tr>`;
    }
}

async function loadAdminTransactions() {
    try {
        const data = await api('/admin/transactions', {
            headers: { 'x-auth-token': adminToken }
        });

        if (!data.transactions.length) {
            txTable.innerHTML = '<tr><td colspan="5">No transactions yet.</td></tr>';
            return;
        }

        txTable.innerHTML = data.transactions
            .slice(0, 10)
            .map((tx) => `
                <tr>
                    <td>${escapeHtml(tx.id)}</td>
                    <td>${escapeHtml(tx.machineId)}</td>
                    <td>${escapeHtml(tx.productId)}</td>
                    <td>${escapeHtml(tx.status)}</td>
                    <td>INR ${tx.amount}</td>
                </tr>
            `)
            .join('');
    } catch (err) {
        txTable.innerHTML = `<tr><td colspan="5">${escapeHtml(err.message)}</td></tr>`;
    }
}

function setText(node, text) {
    node.textContent = text;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

window.startPurchase = startPurchase;
