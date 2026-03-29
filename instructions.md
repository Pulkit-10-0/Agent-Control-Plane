# Agent Control Plane - Development Instructions

## Overview

This project is a VS Code extension for AI agent trace analysis and debugging.

## Trace Rule (ENFORCED)

- Every code change MUST append a new entry to traces/
- Never overwrite or delete existing trace entries

Each append must include:
```json
{
  "timestamp": "",
  "file_changed": "",
  "what_changed": "",
  "why_changed": "",
  "step_number": "auto-increment from last trace"
}
```

## Auto-Generated Rules (Gemini Verified)

<!-- Rules verified by Gemini will be appended below this line -->
