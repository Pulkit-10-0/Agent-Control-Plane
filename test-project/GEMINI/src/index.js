/**
 * Gemini API Client
 * Handles all Gemini API interactions for trace verification
 */
import 'dotenv/config';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

export class GeminiClient {
    constructor(apiKey = process.env.GEMINI_API_KEY) {
        this.apiKey = apiKey;
    }

    /**
     * Send a prompt to Gemini and get a response
     */
    async query(prompt, options = {}) {
        const url = `${GEMINI_API_URL}?key=${this.apiKey}`;

        const body = {
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: options.temperature || 0.7,
                maxOutputTokens: options.maxTokens || 2048,
                topK: options.topK || 40,
                topP: options.topP || 0.95
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Gemini API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return this.extractText(data);
    }

    /**
     * Verify trace coherence
     */
    async verifyTraces(traces) {
        const prompt = `Analyze these code change traces for coherence:

${JSON.stringify(traces, null, 2)}

Check if the changes are coherent and don't contradict each other.
Return JSON only:
{
  "coherent": true/false,
  "conflicts": [{ "step_a": n, "step_b": m, "reason": "..." }],
  "suggestions": ["..."],
  "instructions_md_additions": ["..."]
}`;

        const response = await this.query(prompt, { temperature: 0.1 });
        return this.parseJson(response);
    }

    /**
     * Analyze code quality
     */
    async analyzeCode(code, language = 'javascript') {
        const prompt = `Analyze this ${language} code for quality, potential bugs, and improvements:

\`\`\`${language}
${code}
\`\`\`

Return JSON:
{
  "quality": "good/fair/poor",
  "issues": [{ "line": n, "type": "bug/style/performance", "description": "..." }],
  "suggestions": ["..."]
}`;

        const response = await this.query(prompt, { temperature: 0.2 });
        return this.parseJson(response);
    }

    /**
     * Generate documentation
     */
    async generateDocs(code, language = 'javascript') {
        const prompt = `Generate documentation for this ${language} code:

\`\`\`${language}
${code}
\`\`\`

Include:
- Function descriptions
- Parameter explanations
- Return value descriptions
- Usage examples`;

        return await this.query(prompt, { temperature: 0.5 });
    }

    /**
     * Extract text from Gemini response
     */
    extractText(data) {
        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            return data.candidates[0].content.parts[0].text;
        }
        throw new Error('Invalid response format');
    }

    /**
     * Parse JSON from response text
     */
    parseJson(text) {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[1]);
        }

        // Try to find raw JSON object
        const objectMatch = text.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            return JSON.parse(objectMatch[0]);
        }

        throw new Error('No JSON found in response');
    }
}

export default GeminiClient;
