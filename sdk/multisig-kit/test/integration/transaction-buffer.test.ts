import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compileCompactTransactionMessage,
  fetchMaybeTransactionBuffer,
  fetchTransactionBuffer,
  findTransactionBufferPda,
  getCompactTransactionMessageEncoder,
  getTransactionBufferCreateInstructionAsync,
  getTransactionBufferExtendInstructionAsync,
  getVaultTransactionCreateFromBufferInstructionAsync,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('transaction buffer', () => {
  it('creates a vault transaction from a buffer uploaded in chunks', async () => {
    const { members, multisig, vault } = await ctx.createAutonomousMultisig();
    ctx.fund(vault);
    ctx.fund(members.proposer);
    const destinations = await Promise.all(
      Array.from({ length: 8 }, async () => (await generateKeyPairSigner()).address),
    );
    const amount = 1_000_000n;
    const messageBytes = getCompactTransactionMessageEncoder().encode(
      compileCompactTransactionMessage({
        vault,
        instructions: destinations.map((destination) =>
          getTransferSolInstruction({ source: createNoopSigner(vault), destination, amount }),
        ),
      }),
    );
    const finalBufferHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(messageBytes)),
    );
    const bufferIndex = 0;
    const transactionIndex = 1n;
    const half = Math.ceil(messageBytes.length / 2);

    await ctx.send([
      await getTransactionBufferCreateInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          bufferIndex,
          vaultIndex: 0,
          finalBufferHash,
          finalBufferSize: messageBytes.length,
          buffer: messageBytes.slice(0, half),
        },
        programConfig,
      ),
    ]);
    await ctx.send([
      await getTransactionBufferExtendInstructionAsync(
        { multisig, creator: members.proposer, bufferIndex, buffer: messageBytes.slice(half) },
        programConfig,
      ),
    ]);

    const [transactionBuffer] = await findTransactionBufferPda(
      { multisig, creator: members.proposer.address, bufferIndex },
      programConfig,
    );
    const buffer = await fetchTransactionBuffer(ctx.client.rpc, transactionBuffer);
    expect(buffer.programAddress).toBe(programConfig.programAddress);
    expect(buffer.data.buffer).toEqual(messageBytes);
    expect(buffer.data.finalBufferHash).toEqual(finalBufferHash);

    await ctx.send([
      await getVaultTransactionCreateFromBufferInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionIndex,
          bufferIndex,
        },
        programConfig,
      ),
      ...(await ctx.proposeAndApprove(multisig, members, transactionIndex)),
    ]);
    expect((await fetchMaybeTransactionBuffer(ctx.client.rpc, transactionBuffer)).exists).toBe(
      false,
    );

    await ctx.executeVaultTransaction(multisig, members.executor, transactionIndex);
    for (const destination of destinations) {
      expect(await ctx.getBalance(destination)).toBe(amount);
    }
  });
});
