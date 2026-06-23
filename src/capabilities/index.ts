// === UNIFIED CAPABILITY (RECOMMENDED) ===
export { UnifiedCodingCapabilityModule, createUnifiedCodingCapability, type UnifiedCodingOptions } from './unifiedCodingCapability.js';

// === CORE CAPABILITIES ===
export { FilesystemCapabilityModule, type FilesystemCapabilityOptions } from './filesystemCapability.js';
export { EditCapabilityModule } from './editCapability.js';
export { BashCapabilityModule, type BashCapabilityOptions } from './bashCapability.js';
export { SearchCapabilityModule, type SearchCapabilityOptions } from './searchCapability.js';
export { WebCapabilityModule, type WebCapabilityOptions } from './webCapability.js';
export { EnhancedGitCapabilityModule } from './enhancedGitCapability.js';
export { GitHistoryCapabilityModule } from './gitHistoryCapability.js';
export { HITLCapabilityModule, type HITLCapabilityOptions } from './hitlCapability.js';
// CoworkCapabilityModule moved to ~/GitHub/anvilwing-cowork (2026-05) —
// productivity-assistant surface kept separate from the coding CLI.
// See CLAUDE.md "Capability separation".
export { BaseCapabilityModule, type BaseCapabilityOptions, ToolSuiteBuilder, SharedUtilities } from './baseCapability.js';
