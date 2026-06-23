/**
 * Manual test for Robust Input Processor
 */

import { RobustInputProcessor } from '../dist/shell/inputProcessor.js';

function runTests() {
  // TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
// TODO: Replace with logger
console.log('🧪 Testing Robust Input Processor...\n');
  
  const processor = new RobustInputProcessor();
  
  // Test 1: Single line input
  console.log('Test 1: Single line input');
  const result1 = processor.processInput('Hello world');
  console.log('  Input: "Hello world"');
  console.log('  Result:', JSON.stringify(result1, null, 2));
  console.log('  Display:', processor.formatForDisplay(result1));
  console.log('');
  
  // Test 2: Multi-line input (short)
  console.log('Test 2: Short multi-line input');
  const result2 = processor.processInput('Line 1\nLine 2\nLine 3');
  console.log('  Input: "Line 1\\nLine 2\\nLine 3"');
  console.log('  Result:', JSON.stringify({
    ...result2,
    content: result2.content.replace(/\n/g, '\\n')
  }, null, 2));
  console.log('  Display:', processor.formatForDisplay(result2));
  console.log('');
  
  // Test 3: Long multi-line input
  console.log('Test 3: Long multi-line input');
  const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`);
  const longInput = lines.join('\n');
  const result3 = processor.processInput(longInput);
  console.log('  Input: 15 lines');
  console.log('  Result:', JSON.stringify({
    ...result3,
    content: '[truncated for display]'
  }, null, 2));
  console.log('  Display:', processor.formatForDisplay(result3));
  console.log('');
  
  // Test 4: Initialization warning
  console.log('Test 4: Input with initialization warning');
  const warningInput = 'take a moment for complex initialization... Actual content';
  const { content, hadWarning } = processor.extractContentFromWarning(warningInput);
  console.log('  Input:', warningInput);
  console.log('  Had warning:', hadWarning);
  console.log('  Clean content:', content);
  console.log('');
  
  // Test 5: Validation
  console.log('Test 5: Input validation');
  const validation1 = processor.validateInput('Normal input');
  const validation2 = processor.validateInput('   ');
  console.log('  Normal input:', validation1);
  console.log('  Empty input:', validation2);
  console.log('');
  
  console.log('✅ All manual tests completed successfully!');
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

export { runTests };