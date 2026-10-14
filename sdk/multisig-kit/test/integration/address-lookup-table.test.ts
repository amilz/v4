import {
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { createNoopSigner, generateKeyPairSigner, type Address } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildVaultTransactionCreateInstruction,
  buildVaultTransactionExecuteInstruction,
  fetchVaultTransaction,
  findTransactionPda,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

async function createLookupTable(addresses: Address[]) {
  const recentSlot = await ctx.client.rpc.getSlot({ commitment: 'finalized' }).send();
  const createIx = await getCreateLookupTableInstructionAsync({
    authority: ctx.client.payer,
    payer: ctx.client.payer,
    recentSlot,
  });
  const lookupTable = createIx.accounts[0].address;
  await ctx.send([
    createIx,
    getExtendLookupTableInstruction({
      address: lookupTable,
      authority: ctx.client.payer,
      payer: ctx.client.payer,
      addresses,
    }),
  ]);
  return lookupTable;
}

describe('address lookup tables', () => {
  it('executes a vault transaction whose accounts and program id come from a lookup table', async () => {
    const { members, multisig, vault } = await ctx.createAutonomousMultisig();
    ctx.fund(vault, 5);
    const destinations = await Promise.all(
      Array.from({ length: 3 }, async () => (await generateKeyPairSigner()).address),
    );
    const lookupTable = await createLookupTable([SYSTEM_PROGRAM_ADDRESS, ...destinations]);
    const addressesByLookupTableAddress = {
      [lookupTable]: [SYSTEM_PROGRAM_ADDRESS, ...destinations],
    };
    const transactionIndex = 1n;
    const amount = 1_000_000n;

    await ctx.send([
      await buildVaultTransactionCreateInstruction(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionIndex,
          addressesByLookupTableAddress,
          instructions: destinations.map((destination) =>
            getTransferSolInstruction({ source: createNoopSigner(vault), destination, amount }),
          ),
        },
        programConfig,
      ),
      ...(await ctx.proposeAndApprove(multisig, members, transactionIndex)),
    ]);

    const [transaction] = await findTransactionPda({ multisig, transactionIndex }, programConfig);
    const { message } = (await fetchVaultTransaction(ctx.client.rpc, transaction)).data;
    expect(message.accountKeys).toEqual([vault]);
    expect(message.addressTableLookups).toEqual([
      {
        accountKey: lookupTable,
        writableIndexes: new Uint8Array([1, 2, 3]),
        readonlyIndexes: new Uint8Array([0]),
      },
    ]);

    const execute = await buildVaultTransactionExecuteInstruction(
      { rpc: ctx.client.rpc, multisig, member: members.executor, transactionIndex },
      programConfig,
    );
    expect(execute.addressesByLookupTableAddress).toEqual(addressesByLookupTableAddress);
    const outerMessage = await ctx.buildMessage(
      [execute.instruction],
      undefined,
      execute.addressesByLookupTableAddress,
    );
    expect(
      outerMessage.instructions[0].accounts?.filter((meta) => 'lookupTableAddress' in meta),
    ).toHaveLength(4);
    await ctx.sendMessage(outerMessage);

    for (const destination of destinations) {
      expect(await ctx.getBalance(destination)).toBe(amount);
    }
  });
});
