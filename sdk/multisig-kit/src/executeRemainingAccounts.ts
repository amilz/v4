import {
  AccountRole,
  fetchAddressesForLookupTables,
  type AccountMeta,
  type Address,
  type AddressesByLookupTableAddress,
  type GetMultipleAccountsApi,
  type ReadonlyUint8Array,
  type Rpc,
} from '@solana/kit';
import { findEphemeralSignerPda, type VaultTransactionMessage } from './generated';
import { isSignerIndex, isStaticWritableIndex } from './utils';

export type GetExecuteRemainingAccountsInput = {
  /** Message stored in the `VaultTransaction` or `VaultBatchTransaction` account. */
  message: VaultTransactionMessage;
  ephemeralSignerBumps: ReadonlyUint8Array | readonly number[];
  vault: Address;
  /** Address ephemeral signers are derived from: the vault transaction, or the batch for batch transactions. */
  transaction: Address;
  /** Lookup tables already known locally. Missing ones are fetched with `rpc`. */
  addressesByLookupTableAddress?: AddressesByLookupTableAddress;
  rpc?: Rpc<GetMultipleAccountsApi>;
};

export type ExecuteRemainingAccounts = {
  /** Remaining accounts expected by `vaultTransactionExecute` / `batchExecuteTransaction`. */
  accounts: AccountMeta[];
  /** Lookup tables referenced by `message`, e.g. for `compressTransactionMessageUsingAddressLookupTables`. */
  addressesByLookupTableAddress: AddressesByLookupTableAddress;
};

/** Populates the remaining accounts required to execute a vault or batch transaction. */
export async function getExecuteRemainingAccounts(
  {
    message,
    ephemeralSignerBumps,
    vault,
    transaction,
    addressesByLookupTableAddress: localLookupTables = {},
    rpc,
  }: GetExecuteRemainingAccountsInput,
  config: { programAddress?: Address } = {},
): Promise<ExecuteRemainingAccounts> {
  const ephemeralSigners = new Set(
    await Promise.all(
      Array.from(ephemeralSignerBumps, async (_, ephemeralSignerIndex) => {
        const [address] = await findEphemeralSignerPda(
          { transaction, ephemeralSignerIndex },
          { programAddress: config.programAddress },
        );
        return address;
      }),
    ),
  );

  const lookupTableAddresses = message.addressTableLookups.map(({ accountKey }) => accountKey);
  const missingLookupTables = [...new Set(lookupTableAddresses)].filter(
    (address) => !localLookupTables[address],
  );
  if (missingLookupTables.length > 0 && !rpc) {
    throw new Error(
      `Address lookup table accounts not provided and no rpc to fetch them: ${missingLookupTables.join(', ')}`,
    );
  }
  const fetchedLookupTables =
    missingLookupTables.length > 0
      ? await fetchAddressesForLookupTables(missingLookupTables, rpc!)
      : {};
  const addressesByLookupTableAddress: AddressesByLookupTableAddress = Object.fromEntries(
    lookupTableAddresses.map((address) => [
      address,
      localLookupTables[address] ?? fetchedLookupTables[address],
    ]),
  );

  const accounts: AccountMeta[] = lookupTableAddresses.map((address) => ({
    address,
    role: AccountRole.READONLY,
  }));
  message.accountKeys.forEach((address, index) => {
    const isWritable = isStaticWritableIndex(message, index);
    const isSigner =
      isSignerIndex(message, index) && address !== vault && !ephemeralSigners.has(address);
    accounts.push({ address, role: getAccountRole(isSigner, isWritable) });
  });
  for (const { accountKey, writableIndexes, readonlyIndexes } of message.addressTableLookups) {
    const tableAddresses = addressesByLookupTableAddress[accountKey];
    const resolve = (index: number) => {
      const address = tableAddresses[index];
      if (!address) {
        throw new Error(
          `Address lookup table account ${accountKey} does not contain address at index ${index}`,
        );
      }
      return address;
    };
    for (const index of writableIndexes) {
      accounts.push({ address: resolve(index), role: AccountRole.WRITABLE });
    }
    for (const index of readonlyIndexes) {
      accounts.push({ address: resolve(index), role: AccountRole.READONLY });
    }
  }

  return { accounts, addressesByLookupTableAddress };
}

function getAccountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner) return isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}
