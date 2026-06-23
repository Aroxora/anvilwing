/**
 * Integration test for Anvilwing CLI with robust input processing
 */

import { readFileSync } from 'fs';

// Check if the interactive shell has been updated with our robust input processor
function checkIntegration() {
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
console.log('🔍 Checking Anvilwing CLI integration...\n');
  
  try {
    // Read the updated interactive shell file
    const shellContent = readFile('src/shell/interactiveShell.ts', 'utf8');
    
    // Check for our imports
    const hasInputProcessorImport = shellContent.includes('import { RobustInputProcessor }');
    const hasCapturePastePatchImport = shellContent.includes('import { createRobustCapturePaste');
    const hasProcessInputBlockPatchImport = shellContent.includes('import { createRobustProcessInputBlock');
    
    console.log('✅ Input Processor import:', hasInputProcessorImport);
    console.log('✅ Capture Paste Patch import:', hasCapturePastePatchImport);
    console.log('✅ Process Input Block Patch import:', hasProcessInputBlockPatchImport);
    
    // Check for our instance creation
    const hasInputProcessorInstance = shellContent.includes('private readonly inputProcessor = new RobustInputProcessor()');
    const hasCapturePasteMethod = shellContent.includes('private capturePaste = createRobustCapturePaste(this.inputProcessor)');
    const hasProcessInputBlockMethod = shellContent.includes('private processInputBlock = createRobustProcessInputBlock(this.inputProcessor)');
    
    console.log('✅ Input Processor instance:', hasInputProcessorInstance);
    console.log('✅ Capture Paste method:', hasCapturePasteMethod);
    console.log('✅ Process Input Block method:', hasProcessInputBlockMethod);
    
    // Check if the original methods were replaced
    const hasOriginalCapturePaste = shellContent.includes('private capturePaste(content: string, lineCount: number): void');
    const hasOriginalProcessInputBlock = shellContent.includes('private async processInputBlock(line: string, _wasRapidMultiLine = false): Promise<void>');
    
    console.log('❌ Original Capture Paste method (should be false):', hasOriginalCapturePaste);
    console.log('❌ Original Process Input Block method (should be false):', hasOriginalProcessInputBlock);
    
    const allChecks = [
      hasInputProcessorImport,
      hasCapturePastePatchImport,
      hasProcessInputBlockPatchImport,
      hasInputProcessorInstance,
      hasCapturePasteMethod,
      hasProcessInputBlockMethod,
      !hasOriginalCapturePaste,
      !hasOriginalProcessInputBlock
    ];
    
    const passed = allChecks.every(check => check);
    
    if (passed) {
      console.log('\n🎉 SUCCESS: All integration checks passed!');
      console.log('The robust input processor has been successfully integrated into Anvilwing CLI.');
    } else {
      console.log('\n❌ FAILURE: Some integration checks failed.');
      console.log('Please review the implementation.');
    }
    
    return passed;
    
  } catch (error) {
    console.error('❌ Error checking integration:', error.message);
    return false;
  }
}

// Run integration check
if (import.meta.url === `file://${process.argv[1]}`) {
  checkIntegration();
}

export { checkIntegration };