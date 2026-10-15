import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getBase16Codec,
  getBase64Decoder,
  type Address,
  type GetAccountInfoApi,
  type GetMultipleAccountsApi,
  type Instruction,
  type Rpc,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  buildBatchAddTransactionInstruction,
  buildBatchExecuteTransactionInstruction,
  buildConfigTransactionExecuteInstruction,
  buildVaultTransactionCreateInstruction,
  buildVaultTransactionExecuteInstruction,
  compileCompactTransactionMessage,
  findBatchTransactionPda,
  findEphemeralSignerPda,
  findProposalPda,
  findTransactionPda,
  getBatchAddTransactionInstructionDataDecoder,
  getBatchEncoder,
  getVaultBatchTransactionEncoder,
  getVaultTransactionCreateInstructionDataDecoder,
  getVaultTransactionEncoder,
  type VaultTransactionMessage,
} from '../../src';
import fixtures from './fixtures/legacy-compact-messages.json';

const hex = getBase16Codec();
const programAddress = address(fixtures.programAddress);
const multisig = address(fixtures.multisig);
const vault = address(fixtures.vault);
const recipient = address('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
const lookupTable = address('5Z6Ay5NEcbg3xhopc522sBCRXQujkTiuDRnHGfQdcnSf');
const systemProgram = address('11111111111111111111111111111111');

const transfer = (to: Address): Instruction => ({
  programAddress: systemProgram,
  accounts: [
    { address: vault, role: AccountRole.WRITABLE_SIGNER },
    { address: to, role: AccountRole.WRITABLE },
  ],
  data: hex.encode('0200000040420f0000000000'),
});

function toVaultTransactionMessage(instructions: Instruction[]): VaultTransactionMessage {
  const message = compileCompactTransactionMessage({ instructions, vault });
  return {
    ...message,
    instructions: message.instructions.map((ix) => ({
      ...ix,
      accountIndexes: new Uint8Array(ix.accountIndexes),
    })),
    addressTableLookups: [],
  };
}

function createFakeRpc(accounts: Record<Address, Uint8Array>) {
  const base64 = getBase64Decoder();
  return {
    getAccountInfo: (account: Address) => ({
      send: async () => ({
        context: { slot: 0n },
        value: accounts[account]
          ? {
              data: [base64.decode(accounts[account]), 'base64'],
              executable: false,
              lamports: 1n,
              owner: programAddress,
              space: BigInt(accounts[account].length),
              rentEpoch: 0n,
            }
          : null,
      }),
    }),
  } as unknown as Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;
}

describe('buildVaultTransactionCreateInstruction', () => {
  it('compiles the inner message and derives PDAs with the custom program', async () => {
    const creator = await generateKeyPairSigner();
    const scenario = fixtures.scenarios['sol-transfer'];
    const instruction = await buildVaultTransactionCreateInstruction(
      {
        multisig,
        transactionIndex: 1n,
        creator,
        vaultIndex: 0,
        ephemeralSigners: 0,
        instructions: [transfer(recipient)],
      },
      { programAddress },
    );
    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts[1].address).toBe(fixtures.transaction);
    expect(instruction.accounts[3].address).toBe(creator.address);
    const data = getVaultTransactionCreateInstructionDataDecoder().decode(instruction.data);
    expect(hex.decode(data.transactionMessage)).toBe(scenario.expected.compactMessageHex);
  });

  it('accepts address-bearing objects for the program address and multisig', async () => {
    const creator = await generateKeyPairSigner();
    const scenario = fixtures.scenarios['sol-transfer'];
    const instruction = await buildVaultTransactionCreateInstruction(
      {
        multisig: { address: multisig },
        transactionIndex: 1n,
        creator,
        vaultIndex: 0,
        ephemeralSigners: 0,
        instructions: [transfer(recipient)],
      },
      { programAddress: { address: programAddress } },
    );
    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts[0].address).toBe(multisig);
    expect(instruction.accounts[1].address).toBe(fixtures.transaction);
    const data = getVaultTransactionCreateInstructionDataDecoder().decode(instruction.data);
    expect(hex.decode(data.transactionMessage)).toBe(scenario.expected.compactMessageHex);
  });
});

describe('buildBatchAddTransactionInstruction', () => {
  it('compiles the inner message against the vault of the custom program', async () => {
    const member = await generateKeyPairSigner();
    const instruction = await buildBatchAddTransactionInstruction(
      {
        multisig,
        member,
        vaultIndex: 0,
        batchIndex: 1n,
        transactionIndex: 1,
        ephemeralSigners: 0,
        instructions: [transfer(recipient)],
      },
      { programAddress },
    );
    const [batchTransaction] = await findBatchTransactionPda(
      { multisig, batchIndex: 1n, transactionIndex: 1 },
      { programAddress },
    );
    expect(instruction.accounts.map(({ address }) => address)).toContain(batchTransaction);
    const data = getBatchAddTransactionInstructionDataDecoder().decode(instruction.data);
    expect(hex.decode(data.transactionMessage)).toBe(
      fixtures.scenarios['sol-transfer'].expected.compactMessageHex,
    );
  });
});

describe('buildVaultTransactionExecuteInstruction', () => {
  it('appends remaining accounts using PDAs of the custom program', async () => {
    const member = await generateKeyPairSigner();
    const [transaction] = await findTransactionPda(
      { multisig, transactionIndex: 1n },
      { programAddress },
    );
    const [ephemeralSigner] = await findEphemeralSignerPda(
      { transaction, ephemeralSignerIndex: 0 },
      { programAddress },
    );
    const message = toVaultTransactionMessage([transfer(ephemeralSigner)]);
    const rpc = createFakeRpc({
      [transaction]: new Uint8Array(
        getVaultTransactionEncoder().encode({
          multisig,
          creator: member.address,
          index: 1n,
          bump: 255,
          vaultIndex: 0,
          vaultBump: 255,
          ephemeralSignerBumps: new Uint8Array([255]),
          message,
        }),
      ),
    });

    const { instruction, addressesByLookupTableAddress } =
      await buildVaultTransactionExecuteInstruction(
        { rpc, multisig, member, transactionIndex: 1n },
        { programAddress },
      );

    const [proposal] = await findProposalPda(
      { multisig, transactionIndex: 1n },
      { programAddress },
    );
    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts.slice(0, 4).map(({ address }) => address)).toEqual([
      multisig,
      proposal,
      transaction,
      member.address,
    ]);
    expect(instruction.accounts.slice(4)).toEqual([
      { address: vault, role: AccountRole.WRITABLE },
      { address: ephemeralSigner, role: AccountRole.WRITABLE },
      { address: systemProgram, role: AccountRole.READONLY },
    ]);
    expect(addressesByLookupTableAddress).toEqual({});
  });

  it('accepts address-bearing objects for the program address and multisig', async () => {
    const member = await generateKeyPairSigner();
    const [transaction] = await findTransactionPda(
      { multisig, transactionIndex: 1n },
      { programAddress },
    );
    const message = toVaultTransactionMessage([transfer(recipient)]);
    const rpc = createFakeRpc({
      [transaction]: new Uint8Array(
        getVaultTransactionEncoder().encode({
          multisig,
          creator: member.address,
          index: 1n,
          bump: 255,
          vaultIndex: 0,
          vaultBump: 255,
          ephemeralSignerBumps: new Uint8Array(),
          message,
        }),
      ),
    });

    const { instruction } = await buildVaultTransactionExecuteInstruction(
      { rpc, multisig: { address: multisig }, member, transactionIndex: 1n },
      { programAddress: { address: programAddress } },
    );

    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts[0].address).toBe(multisig);
    expect(instruction.accounts[2].address).toBe(transaction);
    expect(instruction.accounts[4]).toEqual({ address: vault, role: AccountRole.WRITABLE });
  });
});

describe('buildBatchExecuteTransactionInstruction', () => {
  it('derives ephemeral signers from the batch PDA of the custom program', async () => {
    const member = await generateKeyPairSigner();
    const [batch] = await findTransactionPda(
      { multisig, transactionIndex: 2n },
      { programAddress },
    );
    const [batchTransaction] = await findBatchTransactionPda(
      { multisig, batchIndex: 2n, transactionIndex: 1 },
      { programAddress },
    );
    const [ephemeralSigner] = await findEphemeralSignerPda(
      { transaction: batch, ephemeralSignerIndex: 0 },
      { programAddress },
    );
    const message = toVaultTransactionMessage([transfer(ephemeralSigner)]);
    const rpc = createFakeRpc({
      [batch]: new Uint8Array(
        getBatchEncoder().encode({
          multisig,
          creator: member.address,
          index: 2n,
          bump: 255,
          vaultIndex: 0,
          vaultBump: 255,
          size: 1,
          executedTransactionIndex: 0,
        }),
      ),
      [batchTransaction]: new Uint8Array(
        getVaultBatchTransactionEncoder().encode({
          bump: 255,
          ephemeralSignerBumps: new Uint8Array([255]),
          message,
        }),
      ),
    });

    const { instruction } = await buildBatchExecuteTransactionInstruction(
      { rpc, multisig, member, batchIndex: 2n, transactionIndex: 1 },
      { programAddress },
    );

    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts.slice(0, 5).map(({ address }) => address)).toContain(
      batchTransaction,
    );
    expect(instruction.accounts.slice(5)).toEqual([
      { address: vault, role: AccountRole.WRITABLE },
      { address: ephemeralSigner, role: AccountRole.WRITABLE },
      { address: systemProgram, role: AccountRole.READONLY },
    ]);
  });
});

describe('buildConfigTransactionExecuteInstruction', () => {
  it('appends spending limits as writable remaining accounts', async () => {
    const member = await generateKeyPairSigner();
    const instruction = await buildConfigTransactionExecuteInstruction(
      { multisig, member, transactionIndex: 1n, spendingLimits: [lookupTable] },
      { programAddress },
    );
    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts.at(-1)).toEqual({
      address: lookupTable,
      role: AccountRole.WRITABLE,
    });
  });

  it('accepts address-bearing objects for the program address and spending limits', async () => {
    const member = await generateKeyPairSigner();
    const instruction = await buildConfigTransactionExecuteInstruction(
      {
        multisig,
        member,
        transactionIndex: 1n,
        spendingLimits: [{ address: lookupTable }, recipient],
      },
      { programAddress: { address: programAddress } },
    );
    expect(instruction.programAddress).toBe(programAddress);
    expect(instruction.accounts.slice(-2)).toEqual([
      { address: lookupTable, role: AccountRole.WRITABLE },
      { address: recipient, role: AccountRole.WRITABLE },
    ]);
  });
});
