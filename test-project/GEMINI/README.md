# GEMINI Integration

This folder contains the Gemini API integration for the Agent Control Plane.

## Configuration

Set your Gemini API key in `.env.local`:

```
GEMINI_API_KEY=your_api_key_here
```

## Usage

The GeminiService class handles all API interactions:

- `verifyTraces()` - Verifies trace logs for coherence
- `queryWithContext()` - Queries Gemini with trace context
