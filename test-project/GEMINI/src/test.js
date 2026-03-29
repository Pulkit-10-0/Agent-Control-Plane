/**
 * Test Gemini Integration
 */
import { GeminiClient } from './index.js';

async function runTests() {
    console.log('Testing Gemini Integration...\n');

    const client = new GeminiClient();

    // Test 1: Simple query
    console.log('Test 1: Simple query');
    try {
        const response = await client.query('What is 2 + 2? Reply with just the number.');
        console.log('Response:', response);
        console.log('✓ Simple query test passed\n');
    } catch (error) {
        console.error('✗ Simple query test failed:', error.message, '\n');
    }

    // Test 2: Trace verification
    console.log('Test 2: Trace verification');
    try {
        const traces = [
            { step: 1, file: 'app.js', change: 'Added function loadData()' },
            { step: 2, file: 'app.js', change: 'Modified loadData() to be async' },
            { step: 3, file: 'utils.js', change: 'Added helper function' }
        ];

        const result = await client.verifyTraces(traces);
        console.log('Result:', JSON.stringify(result, null, 2));
        console.log('✓ Trace verification test passed\n');
    } catch (error) {
        console.error('✗ Trace verification test failed:', error.message, '\n');
    }

    // Test 3: Code analysis
    console.log('Test 3: Code analysis');
    try {
        const code = `
function add(a, b) {
    return a + b;
}

function divide(a, b) {
    return a / b; // potential divide by zero
}
`;
        const result = await client.analyzeCode(code);
        console.log('Result:', JSON.stringify(result, null, 2));
        console.log('✓ Code analysis test passed\n');
    } catch (error) {
        console.error('✗ Code analysis test failed:', error.message, '\n');
    }

    console.log('All tests completed!');
}

runTests().catch(console.error);
