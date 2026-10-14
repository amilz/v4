import {
  AccountRole,
  type AccountMeta,
  type Address,
  type AddressesByLookupTableAddress,
  type GetAccountInfoApi,
  type GetMultipleAccountsApi,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type Rpc,
  type TransactionSigner,
} from '@solana/kit';
import { compileCompactTransactionMessage } from './compactTransactionMessage';
import { getExecuteRemainingAccounts } from './executeRemainingAccounts';
import {
  fetchBatch,
  fetchVaultBatchTransaction,
  fetchVaultTransaction,
  findBatchTransactionPda,
  findTransactionPda,
  findVaultPda,
  getBatchAddTransactionInstructionAsync,
  getBatchExecuteTransactionInstructionAsync,
  getCompactTransactionMessageEncoder,
  getConfigTransactionExecuteInstructionAsync,
  getVaultTransactionCreateInstructionAsync,
  getVaultTransactionExecuteInstructionAsync,
  type BatchAddTransactionAsyncInput,
  type ConfigTransactionExecuteAsyncInput,
  type VaultTransactionCreateAsyncInput,
} from './generated';

type ProgramAddressConfig = { programAddress?: Address };

export type InstructionWithRemainingAccounts = Instruction &
  InstructionWithAccounts<readonly AccountMeta[]> &
  InstructionWithData<ReadonlyUint8Array>;

export type ExecuteInstructionResult = {
  instruction: InstructionWithRemainingAccounts;
  /** Lookup tables to compress the outer transaction message with. */
  addressesByLookupTableAddress: AddressesByLookupTableAddress;
};

type InnerMessageInput = {
  /** Instructions to wrap into the multisig transaction; the vault acts as their payer. */
  instructions: readonly Instruction[];
  /** Lookup tables used to compress the wrapped message. */
  addressesByLookupTableAddress?: AddressesByLookupTableAddress;
};

export type BuildVaultTransactionCreateInstructionInput = Omit<
  VaultTransactionCreateAsyncInput,
  'multisig' | 'transactionMessage'
> &
  InnerMessageInput & { multisig: Address };

/** Creates a `vaultTransactionCreate` instruction wrapping the given instructions. */
export async function buildVaultTransactionCreateInstruction(
  {
    instructions,
    addressesByLookupTableAddress,
    ...input
  }: BuildVaultTransactionCreateInstructionInput,
  config: ProgramAddressConfig = {},
) {
  const { programAddress } = config;
  const [vault] = await findVaultPda(
    { multisig: input.multisig, vaultIndex: input.vaultIndex },
    { programAddress },
  );
  const transactionMessage = getCompactTransactionMessageEncoder().encode(
    compileCompactTransactionMessage({ instructions, vault, addressesByLookupTableAddress }),
  );
  return await getVaultTransactionCreateInstructionAsync(
    { ...input, transactionMessage },
    { programAddress },
  );
}

export type BuildVaultTransactionExecuteInstructionInput = {
  rpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;
  multisig: Address;
  /** Member of the multisig with the `Execute` permission. */
  member: TransactionSigner;
  transactionIndex: number | bigint;
  /** Lookup tables already known locally. Missing ones are fetched with `rpc`. */
  addressesByLookupTableAddress?: AddressesByLookupTableAddress;
};

/**
 * Fetches the `VaultTransaction` and creates a `vaultTransactionExecute` instruction with all
 * the remaining accounts its message requires.
 */
export async function buildVaultTransactionExecuteInstruction(
  {
    rpc,
    multisig,
    member,
    transactionIndex,
    addressesByLookupTableAddress,
  }: BuildVaultTransactionExecuteInstructionInput,
  config: ProgramAddressConfig = {},
): Promise<ExecuteInstructionResult> {
  const { programAddress } = config;
  const [transaction] = await findTransactionPda(
    { multisig, transactionIndex },
    { programAddress },
  );
  const { data } = await fetchVaultTransaction(rpc, transaction);
  const [vault] = await findVaultPda({ multisig, vaultIndex: data.vaultIndex }, { programAddress });
  const remaining = await getExecuteRemainingAccounts(
    {
      message: data.message,
      ephemeralSignerBumps: data.ephemeralSignerBumps,
      vault,
      transaction,
      addressesByLookupTableAddress,
      rpc,
    },
    { programAddress },
  );
  const instruction = await getVaultTransactionExecuteInstructionAsync(
    { multisig, member, transaction, transactionIndex },
    { programAddress },
  );
  return {
    instruction: appendRemainingAccounts(instruction, remaining.accounts),
    addressesByLookupTableAddress: remaining.addressesByLookupTableAddress,
  };
}

export type BuildBatchAddTransactionInstructionInput = Omit<
  BatchAddTransactionAsyncInput,
  'multisig' | 'transactionMessage'
> &
  InnerMessageInput & {
    multisig: Address;
    /** Index of the vault the batch belongs to. */
    vaultIndex: number;
  };

/** Creates a `batchAddTransaction` instruction wrapping the given instructions. */
export async function buildBatchAddTransactionInstruction(
  {
    instructions,
    addressesByLookupTableAddress,
    vaultIndex,
    ...input
  }: BuildBatchAddTransactionInstructionInput,
  config: ProgramAddressConfig = {},
) {
  const { programAddress } = config;
  const [vault] = await findVaultPda({ multisig: input.multisig, vaultIndex }, { programAddress });
  const transactionMessage = getCompactTransactionMessageEncoder().encode(
    compileCompactTransactionMessage({ instructions, vault, addressesByLookupTableAddress }),
  );
  return await getBatchAddTransactionInstructionAsync(
    { ...input, transactionMessage },
    { programAddress },
  );
}

export type BuildBatchExecuteTransactionInstructionInput = {
  rpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;
  multisig: Address;
  /** Member of the multisig with the `Execute` permission. */
  member: TransactionSigner;
  batchIndex: number | bigint;
  /** Index of the transaction within the batch. */
  transactionIndex: number;
  /** Lookup tables already known locally. Missing ones are fetched with `rpc`. */
  addressesByLookupTableAddress?: AddressesByLookupTableAddress;
};

/**
 * Fetches the `Batch` and `VaultBatchTransaction` and creates a `batchExecuteTransaction`
 * instruction with all the remaining accounts its message requires.
 */
export async function buildBatchExecuteTransactionInstruction(
  {
    rpc,
    multisig,
    member,
    batchIndex,
    transactionIndex,
    addressesByLookupTableAddress,
  }: BuildBatchExecuteTransactionInstructionInput,
  config: ProgramAddressConfig = {},
): Promise<ExecuteInstructionResult> {
  const { programAddress } = config;
  const [[batch], [transaction]] = await Promise.all([
    findTransactionPda({ multisig, transactionIndex: batchIndex }, { programAddress }),
    findBatchTransactionPda({ multisig, batchIndex, transactionIndex }, { programAddress }),
  ]);
  const [batchAccount, transactionAccount] = await Promise.all([
    fetchBatch(rpc, batch),
    fetchVaultBatchTransaction(rpc, transaction),
  ]);
  const [vault] = await findVaultPda(
    { multisig, vaultIndex: batchAccount.data.vaultIndex },
    { programAddress },
  );
  const remaining = await getExecuteRemainingAccounts(
    {
      message: transactionAccount.data.message,
      ephemeralSignerBumps: transactionAccount.data.ephemeralSignerBumps,
      vault,
      transaction: batch,
      addressesByLookupTableAddress,
      rpc,
    },
    { programAddress },
  );
  const instruction = await getBatchExecuteTransactionInstructionAsync(
    { multisig, member, batch, transaction, batchIndex, transactionIndex },
    { programAddress },
  );
  return {
    instruction: appendRemainingAccounts(instruction, remaining.accounts),
    addressesByLookupTableAddress: remaining.addressesByLookupTableAddress,
  };
}

export type BuildConfigTransactionExecuteInstructionInput = ConfigTransactionExecuteAsyncInput & {
  /** Spending limits added or removed by the config transaction. */
  spendingLimits?: readonly Address[];
};

/** Creates a `configTransactionExecute` instruction, passing `spendingLimits` as remaining accounts. */
export async function buildConfigTransactionExecuteInstruction(
  { spendingLimits = [], ...input }: BuildConfigTransactionExecuteInstructionInput,
  config: ProgramAddressConfig = {},
): Promise<InstructionWithRemainingAccounts> {
  const instruction = await getConfigTransactionExecuteInstructionAsync(input, {
    programAddress: config.programAddress,
  });
  return appendRemainingAccounts(
    instruction,
    spendingLimits.map((address) => ({ address, role: AccountRole.WRITABLE })),
  );
}

function appendRemainingAccounts(
  instruction: InstructionWithRemainingAccounts,
  remainingAccounts: readonly AccountMeta[],
): InstructionWithRemainingAccounts {
  return Object.freeze({
    ...instruction,
    accounts: [...instruction.accounts, ...remainingAccounts],
  });
}
