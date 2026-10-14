import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import { createNoopSigner, fetchEncodedAccount, generateKeyPairSigner } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildBatchAddTransactionInstruction,
  buildBatchExecuteTransactionInstruction,
  fetchBatch,
  fetchMaybeBatch,
  fetchMaybeProposal,
  fetchMaybeVaultBatchTransaction,
  fetchProposal,
  findBatchTransactionPda,
  findEphemeralSignerPda,
  findProposalPda,
  findTransactionPda,
  getBatchAccountsCloseInstructionAsync,
  getBatchCreateInstructionAsync,
  getProposalActivateInstructionAsync,
  getProposalApproveInstructionAsync,
  getProposalCreateInstructionAsync,
  getVaultBatchTransactionAccountCloseInstructionAsync,
  SQUADS_MULTISIG_ERROR__TRANSACTION_NOT_LAST_IN_BATCH,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('batch', () => {
  it('executes a batch with an ephemeral signer under the custom program id, then closes it', async () => {
    const rentCollector = (await generateKeyPairSigner()).address;
    const { members, multisig, vault } = await ctx.createAutonomousMultisig({ rentCollector });
    ctx.fund(vault);
    const batchIndex = 1n;
    const [batch] = await findTransactionPda(
      { multisig, transactionIndex: batchIndex },
      programConfig,
    );
    const [ephemeralSigner] = await findEphemeralSignerPda(
      { transaction: batch, ephemeralSignerIndex: 0 },
      programConfig,
    );
    const destination = (await generateKeyPairSigner()).address;
    const vaultSigner = createNoopSigner(vault);
    const addTransaction = (
      transactionIndex: number,
      ephemeralSigners: number,
      instructions: Parameters<typeof buildBatchAddTransactionInstruction>[0]['instructions'],
    ) =>
      buildBatchAddTransactionInstruction(
        {
          multisig,
          member: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          batchIndex,
          transactionIndex,
          ephemeralSigners,
          instructions,
        },
        programConfig,
      );

    await ctx.send([
      await getBatchCreateInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          batchIndex,
          memo: 'ephemeral signer batch',
        },
        programConfig,
      ),
      await getProposalCreateInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          transactionIndex: batchIndex,
          draft: true,
        },
        programConfig,
      ),
      await addTransaction(1, 0, [
        getTransferSolInstruction({ source: vaultSigner, destination, amount: 1_000_000n }),
      ]),
      await addTransaction(2, 1, [
        getCreateAccountInstruction({
          payer: vaultSigner,
          newAccount: createNoopSigner(ephemeralSigner),
          lamports: 1_000_000n,
          space: 0,
          programAddress: SYSTEM_PROGRAM_ADDRESS,
        }),
      ]),
      await getProposalActivateInstructionAsync(
        { multisig, member: members.proposer, transactionIndex: batchIndex },
        programConfig,
      ),
      await getProposalApproveInstructionAsync(
        { multisig, member: members.voter, transactionIndex: batchIndex },
        programConfig,
      ),
      await getProposalApproveInstructionAsync(
        { multisig, member: members.almighty, transactionIndex: batchIndex },
        programConfig,
      ),
    ]);
    expect((await fetchBatch(ctx.client.rpc, batch)).data.size).toBe(2);

    for (const transactionIndex of [1, 2]) {
      const { instruction, addressesByLookupTableAddress } =
        await buildBatchExecuteTransactionInstruction(
          {
            rpc: ctx.client.rpc,
            multisig,
            member: members.executor,
            batchIndex,
            transactionIndex,
          },
          programConfig,
        );
      await ctx.send([instruction], undefined, addressesByLookupTableAddress);
    }

    expect(await ctx.getBalance(destination)).toBe(1_000_000n);
    const created = await fetchEncodedAccount(ctx.client.rpc, ephemeralSigner);
    expect(created.exists && created.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
    const [proposal] = await findProposalPda(
      { multisig, transactionIndex: batchIndex },
      programConfig,
    );
    expect((await fetchProposal(ctx.client.rpc, proposal)).data.status.__kind).toBe('Executed');

    const closeTransaction = (transactionIndex: number) =>
      getVaultBatchTransactionAccountCloseInstructionAsync(
        { multisig, rentCollector, batchIndex, transactionIndex },
        programConfig,
      );
    await ctx.expectProgramError(
      [await closeTransaction(1)],
      SQUADS_MULTISIG_ERROR__TRANSACTION_NOT_LAST_IN_BATCH,
    );
    await ctx.send([
      await closeTransaction(2),
      await closeTransaction(1),
      await getBatchAccountsCloseInstructionAsync(
        { multisig, rentCollector, batchIndex },
        programConfig,
      ),
    ]);

    const [batchTransaction] = await findBatchTransactionPda(
      { multisig, batchIndex, transactionIndex: 1 },
      programConfig,
    );
    expect((await fetchMaybeVaultBatchTransaction(ctx.client.rpc, batchTransaction)).exists).toBe(
      false,
    );
    expect((await fetchMaybeBatch(ctx.client.rpc, batch)).exists).toBe(false);
    expect((await fetchMaybeProposal(ctx.client.rpc, proposal)).exists).toBe(false);
    expect(await ctx.getBalance(rentCollector)).toBeGreaterThan(0n);
  });
});
