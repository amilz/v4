import { extendClient, pipe, type ClientWithRpc, type GetProgramAccountsApi } from '@solana/kit';
import {
  addSelfPlanAndSendFunctions,
  type SelfPlanAndSendFunctions,
} from '@solana/kit/program-client-core';
import {
  squadsMultisigProgram as generatedSquadsMultisigProgram,
  type SquadsMultisigPlugin as GeneratedSquadsMultisigPlugin,
  type SquadsMultisigPluginInstructions as GeneratedSquadsMultisigPluginInstructions,
  type SquadsMultisigPluginRequirements as GeneratedSquadsMultisigPluginRequirements,
} from './generated';
import {
  fetchBatchAccounts,
  fetchConfigTransactionAccounts,
  fetchMultisigAccounts,
  fetchProgramConfigAccounts,
  fetchProposalAccounts,
  fetchSpendingLimitAccounts,
  fetchTransactionBufferAccounts,
  fetchVaultBatchTransactionAccounts,
  fetchVaultTransactionAccounts,
} from './gpa';
import {
  buildBatchAddTransactionInstruction,
  buildBatchExecuteTransactionInstruction,
  buildConfigTransactionExecuteInstruction,
  buildVaultTransactionCreateInstruction,
  buildVaultTransactionExecuteInstruction,
  type BuildBatchAddTransactionInstructionInput,
  type BuildBatchExecuteTransactionInstructionInput,
  type BuildConfigTransactionExecuteInstructionInput,
  type BuildVaultTransactionCreateInstructionInput,
  type BuildVaultTransactionExecuteInstructionInput,
  type InstructionWithRemainingAccounts,
} from './instructions';

type WithoutRpc<TFunction> = TFunction extends (rpc: never, ...args: infer TArgs) => infer TReturn
  ? (...args: TArgs) => TReturn
  : never;

export type SquadsMultisigPluginRequirements = GeneratedSquadsMultisigPluginRequirements &
  ClientWithRpc<GetProgramAccountsApi>;

export type SquadsMultisigPlugin = Omit<GeneratedSquadsMultisigPlugin, 'instructions'> & {
  instructions: SquadsMultisigPluginInstructions;
  gpa: SquadsMultisigPluginGpa;
};

export type SquadsMultisigPluginInstructions = Omit<
  GeneratedSquadsMultisigPluginInstructions,
  | 'vaultTransactionCreate'
  | 'vaultTransactionExecute'
  | 'batchAddTransaction'
  | 'batchExecuteTransaction'
  | 'configTransactionExecute'
> & {
  /** Create a vault transaction wrapping the given instructions into a compact message. */
  vaultTransactionCreate: (
    input: BuildVaultTransactionCreateInstructionInput,
    config?: Parameters<typeof buildVaultTransactionCreateInstruction>[1],
  ) => ReturnType<typeof buildVaultTransactionCreateInstruction> & SelfPlanAndSendFunctions;
  /**
   * Execute a vault transaction, fetching its stored message to append the remaining accounts it
   * requires. The outer transaction is not compressed with lookup tables; use
   * `buildVaultTransactionExecuteInstruction` directly when it needs to be.
   */
  vaultTransactionExecute: (
    input: Omit<BuildVaultTransactionExecuteInstructionInput, 'rpc'>,
    config?: Parameters<typeof buildVaultTransactionExecuteInstruction>[1],
  ) => Promise<InstructionWithRemainingAccounts> & SelfPlanAndSendFunctions;
  /** Add a transaction wrapping the given instructions into a compact message to a batch. */
  batchAddTransaction: (
    input: BuildBatchAddTransactionInstructionInput,
    config?: Parameters<typeof buildBatchAddTransactionInstruction>[1],
  ) => ReturnType<typeof buildBatchAddTransactionInstruction> & SelfPlanAndSendFunctions;
  /**
   * Execute a batch transaction, fetching its stored message to append the remaining accounts it
   * requires. The outer transaction is not compressed with lookup tables; use
   * `buildBatchExecuteTransactionInstruction` directly when it needs to be.
   */
  batchExecuteTransaction: (
    input: Omit<BuildBatchExecuteTransactionInstructionInput, 'rpc'>,
    config?: Parameters<typeof buildBatchExecuteTransactionInstruction>[1],
  ) => Promise<InstructionWithRemainingAccounts> & SelfPlanAndSendFunctions;
  /** Execute a config transaction, passing the spending limits it touches as remaining accounts. */
  configTransactionExecute: (
    input: BuildConfigTransactionExecuteInstructionInput,
    config?: Parameters<typeof buildConfigTransactionExecuteInstruction>[1],
  ) => ReturnType<typeof buildConfigTransactionExecuteInstruction> & SelfPlanAndSendFunctions;
};

/** `getProgramAccounts` queries from `./gpa`, bound to the client's RPC. */
export type SquadsMultisigPluginGpa = {
  multisigs: WithoutRpc<typeof fetchMultisigAccounts>;
  proposals: WithoutRpc<typeof fetchProposalAccounts>;
  vaultTransactions: WithoutRpc<typeof fetchVaultTransactionAccounts>;
  configTransactions: WithoutRpc<typeof fetchConfigTransactionAccounts>;
  batches: WithoutRpc<typeof fetchBatchAccounts>;
  vaultBatchTransactions: WithoutRpc<typeof fetchVaultBatchTransactionAccounts>;
  spendingLimits: WithoutRpc<typeof fetchSpendingLimitAccounts>;
  transactionBuffers: WithoutRpc<typeof fetchTransactionBufferAccounts>;
  programConfigs: WithoutRpc<typeof fetchProgramConfigAccounts>;
};

export function squadsMultisigProgram() {
  return <T extends SquadsMultisigPluginRequirements>(client: T) => {
    return pipe(client, generatedSquadsMultisigProgram(), (c) =>
      extendClient(c, {
        squadsMultisig: <SquadsMultisigPlugin>{
          ...c.squadsMultisig,
          instructions: {
            ...c.squadsMultisig.instructions,
            vaultTransactionCreate: (input, config) =>
              addSelfPlanAndSendFunctions(
                client,
                buildVaultTransactionCreateInstruction(input, config),
              ),
            vaultTransactionExecute: (input, config) =>
              addSelfPlanAndSendFunctions(
                client,
                buildVaultTransactionExecuteInstruction({ ...input, rpc: client.rpc }, config).then(
                  ({ instruction }) => instruction,
                ),
              ),
            batchAddTransaction: (input, config) =>
              addSelfPlanAndSendFunctions(
                client,
                buildBatchAddTransactionInstruction(input, config),
              ),
            batchExecuteTransaction: (input, config) =>
              addSelfPlanAndSendFunctions(
                client,
                buildBatchExecuteTransactionInstruction({ ...input, rpc: client.rpc }, config).then(
                  ({ instruction }) => instruction,
                ),
              ),
            configTransactionExecute: (input, config) =>
              addSelfPlanAndSendFunctions(
                client,
                buildConfigTransactionExecuteInstruction(input, config),
              ),
          },
          gpa: {
            multisigs: (filter, config) => fetchMultisigAccounts(client.rpc, filter, config),
            proposals: (filter, config) => fetchProposalAccounts(client.rpc, filter, config),
            vaultTransactions: (filter, config) =>
              fetchVaultTransactionAccounts(client.rpc, filter, config),
            configTransactions: (filter, config) =>
              fetchConfigTransactionAccounts(client.rpc, filter, config),
            batches: (filter, config) => fetchBatchAccounts(client.rpc, filter, config),
            vaultBatchTransactions: (config) =>
              fetchVaultBatchTransactionAccounts(client.rpc, config),
            spendingLimits: (filter, config) =>
              fetchSpendingLimitAccounts(client.rpc, filter, config),
            transactionBuffers: (filter, config) =>
              fetchTransactionBufferAccounts(client.rpc, filter, config),
            programConfigs: (config) => fetchProgramConfigAccounts(client.rpc, config),
          },
        },
      }),
    );
  };
}
