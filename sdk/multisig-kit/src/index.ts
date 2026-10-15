export * from './generated';
export * from './compactTransactionMessage';
export * from './executeRemainingAccounts';
export * from './gpa';
export * from './instructions';
export * from './permissions';
export * from './utils';

// Generated overrides (must be re-exported explicitly).
export {
  squadsMultisigProgram,
  type SquadsMultisigPlugin,
  type SquadsMultisigPluginGpa,
  type SquadsMultisigPluginInstructions,
  type SquadsMultisigPluginRequirements,
} from './plugin';
