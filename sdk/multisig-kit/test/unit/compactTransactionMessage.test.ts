import {
  AccountRole,
  address,
  getAddressDecoder,
  getBase16Codec,
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  compileCompactTransactionMessage,
  getCompactTransactionMessageCodec,
  getExecuteRemainingAccounts,
  type CompactTransactionMessage,
  type VaultTransactionMessage,
} from '../../src';
import fixtures from './fixtures/legacy-compact-messages.json';

const hex = getBase16Codec();
const codec = getCompactTransactionMessageCodec();
const programAddress = address(fixtures.programAddress);
const vault = address(fixtures.vault);
const transaction = address(fixtures.transaction);

type Scenario = (typeof fixtures.scenarios)[keyof typeof fixtures.scenarios];

function toInstructions(scenario: Scenario): Instruction[] {
  return scenario.input.instructions.map((instruction) => ({
    programAddress: address(instruction.programAddress),
    accounts: instruction.accounts.map((account) => ({
      address: address(account.address),
      role: account.role as AccountRole,
    })),
    data: hex.encode(instruction.dataHex),
  }));
}

function toLookupTables(scenario: Scenario): AddressesByLookupTableAddress {
  return scenario.input.addressesByLookupTableAddress as AddressesByLookupTableAddress;
}

function toVaultTransactionMessage(message: CompactTransactionMessage): VaultTransactionMessage {
  return {
    ...message,
    instructions: message.instructions.map((instruction) => ({
      ...instruction,
      accountIndexes: new Uint8Array(instruction.accountIndexes),
    })),
    addressTableLookups: message.addressTableLookups.map((lookup) => ({
      ...lookup,
      writableIndexes: new Uint8Array(lookup.writableIndexes),
      readonlyIndexes: new Uint8Array(lookup.readonlyIndexes),
    })),
  };
}

const scenarios = Object.entries(fixtures.scenarios);

describe('legacy SDK parity', () => {
  it.each(scenarios)('%s: compiles a byte-identical compact message', (_, scenario) => {
    const message = compileCompactTransactionMessage({
      instructions: toInstructions(scenario),
      vault,
      addressesByLookupTableAddress: toLookupTables(scenario),
    });
    expect(hex.decode(codec.encode(message))).toBe(scenario.expected.compactMessageHex);
  });

  it.each(scenarios)('%s: produces identical execute remaining accounts', async (_, scenario) => {
    const message = codec.decode(hex.encode(scenario.expected.compactMessageHex));
    const { accounts, addressesByLookupTableAddress } = await getExecuteRemainingAccounts(
      {
        message: toVaultTransactionMessage(message),
        ephemeralSignerBumps: new Array<number>(scenario.input.ephemeralSigners).fill(255),
        vault,
        transaction,
        addressesByLookupTableAddress: toLookupTables(scenario),
      },
      { programAddress },
    );
    expect(accounts).toEqual(scenario.expected.executeRemainingAccounts);
    expect(Object.keys(addressesByLookupTableAddress)).toEqual(
      message.addressTableLookups.map(({ accountKey }) => accountKey),
    );
  });

  it.each(scenarios)('%s: round-trips through the compact codec', (_, scenario) => {
    const bytes = hex.encode(scenario.expected.compactMessageHex);
    expect(hex.decode(codec.encode(codec.decode(bytes)))).toBe(scenario.expected.compactMessageHex);
  });
});

describe('compileCompactTransactionMessage', () => {
  const programId = address('J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf');
  const lookupTable = address('5Z6Ay5NEcbg3xhopc522sBCRXQujkTiuDRnHGfQdcnSf');
  const writable = address('GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse');

  it('loads program ids from lookup tables', () => {
    const message = compileCompactTransactionMessage({
      instructions: [{ programAddress: programId, accounts: [{ address: vault, role: 3 }] }],
      vault,
      addressesByLookupTableAddress: { [lookupTable]: [programId] },
    });
    expect(message.accountKeys).toEqual([vault]);
    expect(message.addressTableLookups).toEqual([
      { accountKey: lookupTable, writableIndexes: [], readonlyIndexes: [0] },
    ]);
    expect(message.instructions[0]).toMatchObject({ programIdIndex: 1, accountIndexes: [0] });
  });

  it('always marks the vault as the first writable signer', () => {
    const message = compileCompactTransactionMessage({
      instructions: [{ programAddress: programId, accounts: [{ address: writable, role: 3 }] }],
      vault,
    });
    expect(message.accountKeys.slice(0, 2)).toEqual([vault, writable]);
    expect(message).toMatchObject({ numSigners: 2, numWritableSigners: 2 });
  });

  it('rejects lookup table indexes above 255', () => {
    const table = Array.from({ length: 256 }, () => vault as Address);
    expect(() =>
      compileCompactTransactionMessage({
        instructions: [
          {
            programAddress: programId,
            accounts: [{ address: writable, role: AccountRole.WRITABLE }],
          },
        ],
        vault,
        addressesByLookupTableAddress: { [lookupTable]: [...table, writable] },
      }),
    ).toThrow('Max lookup table index exceeded');
  });

  it('rejects more static account keys than the u8 length prefix allows', () => {
    const accounts = Array.from({ length: 255 }, (_, i) => ({
      address: getAddressDecoder().decode(new Uint8Array(32).fill(i + 1)),
      role: AccountRole.READONLY,
    }));
    const compile = (count: number) =>
      compileCompactTransactionMessage({
        instructions: [{ programAddress: vault, accounts: accounts.slice(0, count) }],
        vault,
      });
    expect(compile(254).accountKeys).toHaveLength(255);
    expect(() => compile(255)).toThrow('Max static account keys length exceeded');
  });
});

describe('getExecuteRemainingAccounts', () => {
  it('fails when a lookup table is neither provided nor fetchable', async () => {
    const scenario = fixtures.scenarios['alt-single'];
    const message = codec.decode(hex.encode(scenario.expected.compactMessageHex));
    await expect(
      getExecuteRemainingAccounts(
        {
          message: toVaultTransactionMessage(message),
          ephemeralSignerBumps: [],
          vault,
          transaction,
        },
        { programAddress },
      ),
    ).rejects.toThrow(Object.keys(scenario.input.addressesByLookupTableAddress)[0]);
  });

  it('fails when a lookup table does not contain a referenced index', async () => {
    const scenario = fixtures.scenarios['alt-single'];
    const message = codec.decode(hex.encode(scenario.expected.compactMessageHex));
    const [lookupTable] = Object.keys(scenario.input.addressesByLookupTableAddress);
    await expect(
      getExecuteRemainingAccounts(
        {
          message: toVaultTransactionMessage(message),
          ephemeralSignerBumps: [],
          vault,
          transaction,
          addressesByLookupTableAddress: { [lookupTable]: [vault] },
        },
        { programAddress },
      ),
    ).rejects.toThrow('does not contain address at index');
  });
});
