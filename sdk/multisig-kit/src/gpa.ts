import {
  decodeAccount,
  getAddressEncoder,
  getBase58Decoder,
  getU8Encoder,
  parseBase64RpcAccount,
  type Account,
  type Address,
  type Base58EncodedBytes,
  type Decoder,
  type GetProgramAccountsApi,
  type GetProgramAccountsMemcmpFilter,
  type ReadonlyUint8Array,
  type Rpc,
} from '@solana/kit';
import {
  BATCH_DISCRIMINATOR,
  CONFIG_TRANSACTION_DISCRIMINATOR,
  getBatchDecoder,
  getConfigTransactionDecoder,
  getMultisigDecoder,
  getProgramConfigDecoder,
  getProposalDecoder,
  getSpendingLimitDecoder,
  getTransactionBufferDecoder,
  getVaultBatchTransactionDecoder,
  getVaultTransactionDecoder,
  MULTISIG_DISCRIMINATOR,
  PROGRAM_CONFIG_DISCRIMINATOR,
  PROPOSAL_DISCRIMINATOR,
  SPENDING_LIMIT_DISCRIMINATOR,
  SQUADS_MULTISIG_PROGRAM_ADDRESS,
  TRANSACTION_BUFFER_DISCRIMINATOR,
  VAULT_BATCH_TRANSACTION_DISCRIMINATOR,
  VAULT_TRANSACTION_DISCRIMINATOR,
  type Batch,
  type ConfigTransaction,
  type Multisig,
  type ProgramConfig,
  type Proposal,
  type ProposalStatus,
  type SpendingLimit,
  type TransactionBuffer,
  type VaultBatchTransaction,
  type VaultTransaction,
} from './generated';

type ProgramAddressConfig = { programAddress?: Address };

export type MultisigAccountsFilter = {
  createKey?: Address;
  configAuthority?: Address;
};

export type ProposalAccountsFilter = {
  multisig?: Address;
  status?: ProposalStatus['__kind'];
};

/** Filter shared by `VaultTransaction`, `ConfigTransaction`, `Batch` and `TransactionBuffer`. */
export type TransactionAccountsFilter = {
  multisig?: Address;
  creator?: Address;
};

export type SpendingLimitAccountsFilter = {
  multisig?: Address;
  vaultIndex?: number;
  mint?: Address;
};

const PROPOSAL_STATUS_KINDS: readonly ProposalStatus['__kind'][] = [
  'Draft',
  'Active',
  'Rejected',
  'Approved',
  'Executing',
  'Executed',
  'Cancelled',
];

/** Fetches all `Multisig` accounts, optionally filtered by `createKey` and `configAuthority`. */
export function fetchMultisigAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  { createKey, configAuthority }: MultisigAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<Multisig>[]> {
  return fetchProgramAccounts(rpc, MULTISIG_DISCRIMINATOR, getMultisigDecoder(), config, [
    addressFilter(8, createKey),
    addressFilter(40, configAuthority),
  ]);
}

/** Fetches all `Proposal` accounts, optionally filtered by `multisig` and `status`. */
export function fetchProposalAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  { multisig, status }: ProposalAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<Proposal>[]> {
  return fetchProgramAccounts(rpc, PROPOSAL_DISCRIMINATOR, getProposalDecoder(), config, [
    addressFilter(8, multisig),
    status === undefined
      ? undefined
      : memcmp(48, getU8Encoder().encode(PROPOSAL_STATUS_KINDS.indexOf(status))),
  ]);
}

/** Fetches all `VaultTransaction` accounts, optionally filtered by `multisig` and `creator`. */
export function fetchVaultTransactionAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  filter: TransactionAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<VaultTransaction>[]> {
  return fetchProgramAccounts(
    rpc,
    VAULT_TRANSACTION_DISCRIMINATOR,
    getVaultTransactionDecoder(),
    config,
    transactionFilters(filter),
  );
}

/** Fetches all `ConfigTransaction` accounts, optionally filtered by `multisig` and `creator`. */
export function fetchConfigTransactionAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  filter: TransactionAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<ConfigTransaction>[]> {
  return fetchProgramAccounts(
    rpc,
    CONFIG_TRANSACTION_DISCRIMINATOR,
    getConfigTransactionDecoder(),
    config,
    transactionFilters(filter),
  );
}

/** Fetches all `Batch` accounts, optionally filtered by `multisig` and `creator`. */
export function fetchBatchAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  filter: TransactionAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<Batch>[]> {
  return fetchProgramAccounts(
    rpc,
    BATCH_DISCRIMINATOR,
    getBatchDecoder(),
    config,
    transactionFilters(filter),
  );
}

/**
 * Fetches all `VaultBatchTransaction` accounts. The account stores no reference to its batch or
 * multisig, so derive addresses with `findBatchTransactionPda` when scoping to a single batch.
 */
export function fetchVaultBatchTransactionAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  config: ProgramAddressConfig = {},
): Promise<Account<VaultBatchTransaction>[]> {
  return fetchProgramAccounts(
    rpc,
    VAULT_BATCH_TRANSACTION_DISCRIMINATOR,
    getVaultBatchTransactionDecoder(),
    config,
  );
}

/** Fetches all `SpendingLimit` accounts, optionally filtered by `multisig`, `vaultIndex` and `mint`. */
export function fetchSpendingLimitAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  { multisig, vaultIndex, mint }: SpendingLimitAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<SpendingLimit>[]> {
  return fetchProgramAccounts(
    rpc,
    SPENDING_LIMIT_DISCRIMINATOR,
    getSpendingLimitDecoder(),
    config,
    [
      addressFilter(8, multisig),
      vaultIndex === undefined ? undefined : memcmp(72, getU8Encoder().encode(vaultIndex)),
      addressFilter(73, mint),
    ],
  );
}

/** Fetches all `TransactionBuffer` accounts, optionally filtered by `multisig` and `creator`. */
export function fetchTransactionBufferAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  filter: TransactionAccountsFilter = {},
  config: ProgramAddressConfig = {},
): Promise<Account<TransactionBuffer>[]> {
  return fetchProgramAccounts(
    rpc,
    TRANSACTION_BUFFER_DISCRIMINATOR,
    getTransactionBufferDecoder(),
    config,
    transactionFilters(filter),
  );
}

/** Fetches all `ProgramConfig` accounts. */
export function fetchProgramConfigAccounts(
  rpc: Rpc<GetProgramAccountsApi>,
  config: ProgramAddressConfig = {},
): Promise<Account<ProgramConfig>[]> {
  return fetchProgramAccounts(rpc, PROGRAM_CONFIG_DISCRIMINATOR, getProgramConfigDecoder(), config);
}

async function fetchProgramAccounts<TData extends object>(
  rpc: Rpc<GetProgramAccountsApi>,
  discriminator: ReadonlyUint8Array,
  decoder: Decoder<TData>,
  { programAddress = SQUADS_MULTISIG_PROGRAM_ADDRESS }: ProgramAddressConfig,
  filters: (GetProgramAccountsMemcmpFilter | undefined)[] = [],
): Promise<Account<TData>[]> {
  const accounts = await rpc
    .getProgramAccounts(programAddress, {
      encoding: 'base64',
      filters: [memcmp(0, discriminator), ...filters.filter((filter) => filter !== undefined)],
    })
    .send();
  return accounts.map(({ pubkey, account }) =>
    decodeAccount(parseBase64RpcAccount(pubkey, account), decoder),
  );
}

function transactionFilters({ multisig, creator }: TransactionAccountsFilter) {
  return [addressFilter(8, multisig), addressFilter(40, creator)];
}

function addressFilter(offset: number, address: Address | undefined) {
  return address === undefined ? undefined : memcmp(offset, getAddressEncoder().encode(address));
}

function memcmp(offset: number, bytes: ReadonlyUint8Array): GetProgramAccountsMemcmpFilter {
  return {
    memcmp: {
      offset: BigInt(offset),
      bytes: getBase58Decoder().decode(bytes) as Base58EncodedBytes,
      encoding: 'base58',
    },
  };
}
