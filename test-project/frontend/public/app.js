/**
 * ACP Test Frontend - Task Manager
 * Connects to backend API for task management
 */

const API_URL = 'http://localhost:3001/api';

// DOM Elements
const taskList = document.getElementById('task-list');
const taskInput = document.getElementById('task-input');
const statusEl = document.getElementById('status');

// Stats elements
const statTotal = document.getElementById('stat-total');
const statCompleted = document.getElementById('stat-completed');
const statPending = document.getElementById('stat-pending');
const statRate = document.getElementById('stat-rate');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadTasks();
    loadStats();

    // Enter key to add task
    taskInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            addTask();
        }
    });
});

// Load all tasks from backend
async function loadTasks() {
    try {
        const response = await fetch(`${API_URL}/tasks`);
        const data = await response.json();

        renderTasks(data.tasks);
        setStatus('Connected to backend', 'connected');
    } catch (error) {
        console.error('Failed to load tasks:', error);
        setStatus('Failed to connect to backend', 'error');
        taskList.innerHTML = '<div class="empty">Unable to load tasks. Is the backend running?</div>';
    }
}

// Load stats from backend
async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/stats`);
        const data = await response.json();

        statTotal.textContent = data.total;
        statCompleted.textContent = data.completed;
        statPending.textContent = data.pending;
        statRate.textContent = data.completionRate;
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// Render tasks to DOM
function renderTasks(tasks) {
    if (tasks.length === 0) {
        taskList.innerHTML = '<div class="empty">No tasks yet. Add one above!</div>';
        return;
    }

    taskList.innerHTML = tasks.map(task => `
        <div class="task-item ${task.completed ? 'completed' : ''}" data-id="${task.id}">
            <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTask(${task.id}, this.checked)">
            <span class="title">${escapeHtml(task.title)}</span>
            <button class="delete" onclick="deleteTask(${task.id})">×</button>
        </div>
    `).join('');
}

// Add new task
async function addTask() {
    const title = taskInput.value.trim();
    if (!title) return;

    try {
        const response = await fetch(`${API_URL}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });

        if (response.ok) {
            taskInput.value = '';
            loadTasks();
            loadStats();
        }
    } catch (error) {
        console.error('Failed to add task:', error);
        setStatus('Failed to add task', 'error');
    }
}

// Toggle task completion
async function toggleTask(id, completed) {
    try {
        await fetch(`${API_URL}/tasks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed })
        });

        loadTasks();
        loadStats();
    } catch (error) {
        console.error('Failed to update task:', error);
    }
}

// Delete task
async function deleteTask(id) {
    try {
        await fetch(`${API_URL}/tasks/${id}`, {
            method: 'DELETE'
        });

        loadTasks();
        loadStats();
    } catch (error) {
        console.error('Failed to delete task:', error);
    }
}

// Helper: Set status message
function setStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
}

// Helper: Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
