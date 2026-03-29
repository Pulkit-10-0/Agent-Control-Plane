/**
 * Test Backend Server
 * Simple Express API for ACP tracing demo
 */
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory data store
let tasks = [
    { id: 1, title: 'Learn ACP', completed: false, createdAt: new Date().toISOString() },
    { id: 2, title: 'Build agent', completed: false, createdAt: new Date().toISOString() },
    { id: 3, title: 'Test tracing', completed: true, createdAt: new Date().toISOString() }
];

let nextId = 4;

// Routes
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get all tasks
app.get('/api/tasks', (req, res) => {
    res.json({ tasks, count: tasks.length });
});

// Get single task
app.get('/api/tasks/:id', (req, res) => {
    const task = tasks.find(t => t.id === parseInt(req.params.id));
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
});

// Create task
app.post('/api/tasks', (req, res) => {
    const { title } = req.body;
    if (!title) {
        return res.status(400).json({ error: 'Title is required' });
    }

    const task = {
        id: nextId++,
        title,
        completed: false,
        createdAt: new Date().toISOString()
    };

    tasks.push(task);
    res.status(201).json(task);
});

// Update task
app.put('/api/tasks/:id', (req, res) => {
    const task = tasks.find(t => t.id === parseInt(req.params.id));
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    const { title, completed } = req.body;
    if (title !== undefined) task.title = title;
    if (completed !== undefined) task.completed = completed;

    res.json(task);
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
    const index = tasks.findIndex(t => t.id === parseInt(req.params.id));
    if (index === -1) {
        return res.status(404).json({ error: 'Task not found' });
    }

    tasks.splice(index, 1);
    res.status(204).send();
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
    const completed = tasks.filter(t => t.completed).length;
    const pending = tasks.length - completed;

    res.json({
        total: tasks.length,
        completed,
        pending,
        completionRate: tasks.length > 0 ? (completed / tasks.length * 100).toFixed(1) + '%' : '0%'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});

module.exports = app;
