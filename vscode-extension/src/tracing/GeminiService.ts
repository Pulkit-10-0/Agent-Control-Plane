/**
 * GeminiService - Handles Gemini API integration for trace verification
 *
 * Verifies that code changes are coherent and don't contradict each other.
 * Uses the Gemini API to analyze sequential trace logs.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TraceLogEntry, GeminiVerificationResult } from './TraceSessionLogger';

export class GeminiService {
    private apiKey: string | null = null;

    constructor(private workspaceRoot: string) {
        this.loadApiKey();
    }

    private loadApiKey(): void {
        // Try to load from .env.local
        const envPath = path.join(this.workspaceRoot, '.env.local');

        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            const match = content.match(/GEMINI_API_KEY=(.+)/);
            if (match) {
                this.apiKey = match[1].trim();
                return;
            }
        }

        // Try extension's .env.local
        const extEnvPath = path.join(this.workspaceRoot, 'vscode-extension', '.env.local');
        if (fs.existsSync(extEnvPath)) {
            const content = fs.readFileSync(extEnvPath, 'utf-8');
            const match = content.match(/GEMINI_API_KEY=(.+)/);
            if (match) {
                this.apiKey = match[1].trim();
                return;
            }
        }

        // Fall back to VS Code settings
        const config = vscode.workspace.getConfiguration('agent-control-plane');
        this.apiKey = config.get<string>('geminiApiKey') || null;
    }

    public isConfigured(): boolean {
        return this.apiKey !== null && this.apiKey.length > 0;
    }

    /**
     * Verify trace logs for coherence using Gemini API
     */
    public async verifyTraces(logs: TraceLogEntry[]): Promise<GeminiVerificationResult | null> {
        if (!this.isConfigured()) {
            vscode.window.showWarningMessage(
                'Gemini API key not configured. Set GEMINI_API_KEY in .env.local'
            );
            return null;
        }

        // Build the prompt
        const logsFormatted = logs.map(log => ({
            step: log.step_number,
            file: log.file_path,
            change: log.what_changed,
            before: log.before_snippet.substring(0, 200),
            after: log.after_snippet.substring(0, 200)
        }));

        const prompt = `Here are sequential code changes made during a vibe coding session.
Check if they are coherent and do not contradict each other.
Check if any step breaks what a previous step built.

Changes:
${JSON.stringify(logsFormatted, null, 2)}

Return ONLY valid JSON in this exact format:
{
  "coherent": true,
  "conflicts": [],
  "suggestions": [],
  "instructions_md_additions": []
}

If there are conflicts, set coherent to false and fill in the conflicts array with objects like:
{ "step_a": 1, "step_b": 3, "reason": "Step 3 removes code added in Step 1" }

Provide helpful suggestions in the suggestions array.
If you identify patterns that should be rules, add them to instructions_md_additions.`;

        try {
            const response = await this.callGeminiApi(prompt);
            return this.parseGeminiResponse(response);
        } catch (err) {
            console.error('[GeminiService] API call failed:', err);
            throw err;
        }
    }

    private async callGeminiApi(prompt: string): Promise<string> {
        // Using the Gemini REST API
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;

        const body = {
            contents: [{
                parts: [{
                    text: prompt
                }]
            }],
            generationConfig: {
                temperature: 0.1,
                topK: 1,
                topP: 0.8,
                maxOutputTokens: 2048
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as any;

        // Extract text from response
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            const parts = data.candidates[0].content.parts;
            if (parts && parts[0] && parts[0].text) {
                return parts[0].text;
            }
        }

        throw new Error('Invalid response format from Gemini API');
    }

    private parseGeminiResponse(response: string): GeminiVerificationResult {
        // Try to extract JSON from the response
        let jsonStr = response;

        // Remove markdown code blocks if present
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        }

        // Try to find JSON object in the response
        const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            jsonStr = objectMatch[0];
        }

        try {
            const parsed = JSON.parse(jsonStr);

            // Validate and normalize the response
            return {
                coherent: typeof parsed.coherent === 'boolean' ? parsed.coherent : true,
                conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                instructions_md_additions: Array.isArray(parsed.instructions_md_additions)
                    ? parsed.instructions_md_additions
                    : []
            };
        } catch (err) {
            console.error('[GeminiService] Failed to parse response:', response);
            // Return a default coherent result if parsing fails
            return {
                coherent: true,
                conflicts: [],
                suggestions: ['Unable to parse Gemini response'],
                instructions_md_additions: []
            };
        }
    }

    /**
     * Send a custom query to Gemini with trace context
     */
    public async queryWithContext(
        query: string,
        logs: TraceLogEntry[]
    ): Promise<string> {
        if (!this.isConfigured()) {
            return 'Gemini API key not configured. Set GEMINI_API_KEY in .env.local';
        }

        const logsFormatted = logs.slice(-10).map(log => ({
            step: log.step_number,
            file: log.file_path,
            change: log.what_changed
        }));

        const prompt = `You are an AI coding assistant with access to recent code change history.

Recent code changes:
${JSON.stringify(logsFormatted, null, 2)}

User question: ${query}

Please answer the question, taking into account the recent code changes if relevant.`;

        try {
            return await this.callGeminiApi(prompt);
        } catch (err) {
            return `Error querying Gemini: ${err}`;
        }
    }
}
