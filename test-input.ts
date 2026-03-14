import { InputTokenizer } from './src/core/tokenizer.ts';

const tokenizer = new InputTokenizer();

function test(name: string, input: string, expected: any) {
  const tokens = tokenizer.feed(input);
  const result = tokens[0];
  
  let passed = true;
  for (const key in expected) {
    if ((result as any)[key] !== expected[key]) {
      passed = false;
      break;
    }
  }

  if (passed) {
    console.log(`PASS: ${name}`);
  } else {
    console.log(`FAIL: ${name}`);
    console.log(`  Expected: ${JSON.stringify(expected)}`);
    console.log(`  Actual:   ${JSON.stringify(result)}`);
    process.exit(1);
  }
}

console.log('--- Starting Tokenizer Tests ---');

// 1. Normal Text
test('Printable Text', 'a', { type: 'text', value: 'a' });

// 2. Ctrl+C (Legacy)
test('Ctrl+C Legacy', '\x03', { type: 'key', logicalName: 'c', ctrl: true });

// 3. Enter (\r)
test('Enter Legacy', '\r', { type: 'key', logicalName: 'enter', shift: false });

// 4. Shift+Enter (\n)
test('Shift+Enter Legacy', '\n', { type: 'key', logicalName: 'enter', shift: true });

// 5. Escape+Enter
test('Shift+Enter Alt-Sequence', '\x1b\r', { type: 'key', logicalName: 'enter', shift: true });

console.log('--- All Tests Passed ---');
