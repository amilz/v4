import {
  AccountRole,
  mergeRoles,
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
} from '@solana/kit';
import type { CompactMessageAddressTableLookup, CompactTransactionMessage } from './generated';

export type CompileCompactTransactionMessageInput = {
  /** Instructions to be executed by the vault. */
  instructions: readonly Instruction[];
  /** Vault PDA that acts as the payer of the inner transaction. */
  vault: Address;
  /** Lookup tables used to load non-signer accounts (including program ids) referenced by `instructions`. */
  addressesByLookupTableAddress?: AddressesByLookupTableAddress;
};

/**
 * Compiles instructions into the compact message accepted by `vaultTransactionCreate`,
 * `batchAddTransaction` and transaction buffers. Unlike a regular v0 message, program ids are
 * not treated as invoked, so they can also be loaded from address lookup tables.
 * Encode the result with `getCompactTransactionMessageEncoder()`.
 */
export function compileCompactTransactionMessage({
  instructions,
  vault,
  addressesByLookupTableAddress = {},
}: CompileCompactTransactionMessageInput): CompactTransactionMessage {
  const roles = new Map<Address, AccountRole>([[vault, AccountRole.WRITABLE_SIGNER]]);
  const addKey = (address: Address, role: AccountRole) =>
    roles.set(address, mergeRoles(roles.get(address) ?? AccountRole.READONLY, role));
  for (const instruction of instructions) {
    addKey(instruction.programAddress, AccountRole.READONLY);
    for (const account of instruction.accounts ?? []) {
      addKey(account.address, account.role);
    }
  }

  const drainKeysFoundInLookupTable = (
    tableAddresses: readonly Address[],
    role: AccountRole.WRITABLE | AccountRole.READONLY,
    drainedKeys: Address[],
  ) => {
    const indexes: number[] = [];
    for (const [address, keyRole] of roles) {
      if (keyRole !== role) continue;
      const index = tableAddresses.indexOf(address);
      if (index < 0) continue;
      if (index >= 256) throw new Error('Max lookup table index exceeded');
      indexes.push(index);
      drainedKeys.push(address);
      roles.delete(address);
    }
    return indexes;
  };

  const addressTableLookups: CompactMessageAddressTableLookup[] = [];
  const writableLookupKeys: Address[] = [];
  const readonlyLookupKeys: Address[] = [];
  for (const [accountKey, tableAddresses] of Object.entries(addressesByLookupTableAddress)) {
    const writableIndexes = drainKeysFoundInLookupTable(
      tableAddresses,
      AccountRole.WRITABLE,
      writableLookupKeys,
    );
    const readonlyIndexes = drainKeysFoundInLookupTable(
      tableAddresses,
      AccountRole.READONLY,
      readonlyLookupKeys,
    );
    if (writableIndexes.length > 0 || readonlyIndexes.length > 0) {
      addressTableLookups.push({
        accountKey: accountKey as Address,
        writableIndexes,
        readonlyIndexes,
      });
    }
  }

  if (roles.size > 255) throw new Error('Max static account keys length exceeded');
  const keysWithRole = (role: AccountRole) =>
    [...roles].filter(([, keyRole]) => keyRole === role).map(([address]) => address);
  const writableSigners = keysWithRole(AccountRole.WRITABLE_SIGNER);
  const readonlySigners = keysWithRole(AccountRole.READONLY_SIGNER);
  const writableNonSigners = keysWithRole(AccountRole.WRITABLE);
  const readonlyNonSigners = keysWithRole(AccountRole.READONLY);
  if (writableSigners[0] !== vault) {
    throw new Error('Expected first writable signer key to be the vault');
  }
  const accountKeys = [
    ...writableSigners,
    ...readonlySigners,
    ...writableNonSigners,
    ...readonlyNonSigners,
  ];

  const allKeys = [...accountKeys, ...writableLookupKeys, ...readonlyLookupKeys];
  if (allKeys.length > 256) {
    throw new Error('Account index overflow encountered during compilation');
  }
  const keyIndexes = new Map(allKeys.map((address, index) => [address, index]));
  const indexOf = (address: Address) => keyIndexes.get(address)!;

  return {
    numSigners: writableSigners.length + readonlySigners.length,
    numWritableSigners: writableSigners.length,
    numWritableNonSigners: writableNonSigners.length,
    accountKeys,
    instructions: instructions.map((instruction) => ({
      programIdIndex: indexOf(instruction.programAddress),
      accountIndexes: (instruction.accounts ?? []).map((account) => indexOf(account.address)),
      data: instruction.data ?? new Uint8Array(),
    })),
    addressTableLookups,
  };
}
