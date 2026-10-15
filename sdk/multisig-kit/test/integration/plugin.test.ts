import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, generateKeyPairSigner, type Address } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allPermissions,
  Period,
  getSquadsMultisigErrorMessage,
  isSquadsMultisigError,
  squadsMultisigProgram,
  SQUADS_MULTISIG_ERROR__ALREADY_APPROVED,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const LAMPORTS_PER_SOL = 1_000_000_000n;

const ctx = await createTestContext();
const { treasury } = ctx;
const client = ctx.client.use(squadsMultisigProgram(programConfig));
afterAll(() => client.surfnet.stop());

async function createMultisig() {
  const [alice, bob, executor, createKey] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  const [multisig] = await client.squadsMultisig.pdas.multisig({ createKey: createKey.address });
  const [vault] = await client.squadsMultisig.pdas.vault({ multisig, vaultIndex: 0 });

  await client.squadsMultisig.instructions
    .multisigCreateV2({
      treasury,
      createKey,
      creator: client.payer,
      configAuthority: null,
      threshold: 2,
      members: [alice, bob, executor].map((member) => ({
        key: member.address,
        permissions: allPermissions(),
      })),
      timeLock: 0,
      rentCollector: null,
    })
    .sendTransaction();

  return { alice, bob, executor, multisig, vault };
}

async function approve(
  multisig: Address,
  transactionIndex: bigint,
  members: Parameters<typeof client.squadsMultisig.instructions.proposalApprove>[0]['member'][],
) {
  for (const member of members) {
    await client.squadsMultisig.instructions
      .proposalApprove({ multisig, member, transactionIndex })
      .sendTransaction();
  }
}

describe('squadsMultisigProgram() plugin', () => {
  it('creates a multisig and reads it back', async () => {
    const { alice, bob, executor, multisig } = await createMultisig();

    const account = await client.squadsMultisig.accounts.multisig.fetch(multisig);

    expect(account.programAddress).toBe(programConfig.programAddress);
    expect(account.data.threshold).toBe(2);
    expect(account.data.members.map((m) => m.key).sort()).toEqual(
      [alice, bob, executor].map((m) => m.address).sort(),
    );
    const [found] = await client.squadsMultisig.gpa.multisigs({
      createKey: account.data.createKey,
    });
    expect(found.address).toBe(multisig);
  });

  it('runs a vault transaction that transfers SOL', async () => {
    const { alice, bob, executor, multisig, vault } = await createMultisig();
    const destination = (await generateKeyPairSigner()).address;
    const amount = LAMPORTS_PER_SOL;
    client.surfnet.fundSol(vault, Number(2n * LAMPORTS_PER_SOL));
    const transactionIndex = 1n;
    const { instructions, gpa } = client.squadsMultisig;

    await instructions
      .vaultTransactionCreate({
        multisig,
        creator: alice,
        rentPayer: client.payer,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionIndex,
        instructions: [
          getTransferSolInstruction({ source: createNoopSigner(vault), destination, amount }),
        ],
      })
      .sendTransaction();
    await instructions
      .proposalCreate({ multisig, creator: alice, rentPayer: client.payer, transactionIndex })
      .sendTransaction();
    await approve(multisig, transactionIndex, [alice, bob]);

    const [proposalPda] = await client.squadsMultisig.pdas.proposal({ multisig, transactionIndex });
    const approved = await gpa.proposals({ multisig, status: 'Approved' });
    expect(approved.map(({ address }) => address)).toEqual([proposalPda]);
    expect(await gpa.proposals({ multisig, status: 'Executed' })).toEqual([]);
    const [transaction] = await gpa.vaultTransactions({ multisig, creator: alice.address });
    expect(transaction.data.index).toBe(transactionIndex);

    await instructions
      .vaultTransactionExecute({ multisig, member: executor, transactionIndex })
      .sendTransaction();

    expect((await client.rpc.getBalance(destination).send()).value).toBe(amount);
    expect((await client.rpc.getBalance(vault).send()).value).toBe(LAMPORTS_PER_SOL);
    const executed = await gpa.proposals({ multisig, status: 'Executed' });
    expect(executed.map(({ address }) => address)).toEqual([proposalPda]);
  });

  it('runs a batch', async () => {
    const { alice, bob, executor, multisig, vault } = await createMultisig();
    const destination = (await generateKeyPairSigner()).address;
    client.surfnet.fundSol(vault, Number(LAMPORTS_PER_SOL));
    const batchIndex = 1n;
    const { instructions } = client.squadsMultisig;

    await instructions
      .batchCreate({ multisig, creator: alice, rentPayer: client.payer, vaultIndex: 0, batchIndex })
      .sendTransaction();
    await instructions
      .proposalCreate({
        multisig,
        creator: alice,
        rentPayer: client.payer,
        transactionIndex: batchIndex,
        draft: true,
      })
      .sendTransaction();
    for (const transactionIndex of [1, 2]) {
      await instructions
        .batchAddTransaction({
          multisig,
          member: alice,
          rentPayer: client.payer,
          vaultIndex: 0,
          batchIndex,
          transactionIndex,
          ephemeralSigners: 0,
          instructions: [
            getTransferSolInstruction({
              source: createNoopSigner(vault),
              destination,
              amount: 1_000_000n,
            }),
          ],
        })
        .sendTransaction();
    }
    await instructions
      .proposalActivate({ multisig, member: alice, transactionIndex: batchIndex })
      .sendTransaction();
    await approve(multisig, batchIndex, [alice, bob]);

    for (const transactionIndex of [1, 2]) {
      await instructions
        .batchExecuteTransaction({ multisig, member: executor, batchIndex, transactionIndex })
        .sendTransaction();
    }

    expect((await client.rpc.getBalance(destination).send()).value).toBe(2_000_000n);
    const [batch] = await client.squadsMultisig.gpa.batches({ multisig });
    expect(batch.data.executedTransactionIndex).toBe(2);
  });

  it('executes a config transaction that adds a spending limit', async () => {
    const { alice, bob, executor, multisig } = await createMultisig();
    const createKey = (await generateKeyPairSigner()).address;
    const [spendingLimit] = await client.squadsMultisig.pdas.spendingLimit({ multisig, createKey });
    const transactionIndex = 1n;
    const { instructions } = client.squadsMultisig;

    await instructions
      .configTransactionCreate({
        multisig,
        creator: alice,
        rentPayer: client.payer,
        transactionIndex,
        actions: [
          {
            __kind: 'AddSpendingLimit',
            createKey,
            vaultIndex: 0,
            mint: '11111111111111111111111111111111' as Address,
            amount: LAMPORTS_PER_SOL,
            period: Period.Day,
            members: [alice.address],
            destinations: [],
          },
        ],
      })
      .sendTransaction();
    await instructions
      .proposalCreate({ multisig, creator: alice, rentPayer: client.payer, transactionIndex })
      .sendTransaction();
    await approve(multisig, transactionIndex, [alice, bob]);

    await instructions
      .configTransactionExecute({
        multisig,
        member: executor,
        rentPayer: client.payer,
        transactionIndex,
        spendingLimits: [spendingLimit],
      })
      .sendTransaction();

    const limits = await client.squadsMultisig.gpa.spendingLimits({ multisig, vaultIndex: 0 });
    expect(limits.map(({ address }) => address)).toEqual([spendingLimit]);
    expect(limits[0].data.amount).toBe(LAMPORTS_PER_SOL);
  });

  it('decodes program errors with isSquadsMultisigError', async () => {
    const { alice, multisig, vault } = await createMultisig();
    const transactionIndex = 1n;
    const { instructions } = client.squadsMultisig;
    await instructions
      .vaultTransactionCreate({
        multisig,
        creator: alice,
        rentPayer: client.payer,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionIndex,
        instructions: [
          getTransferSolInstruction({
            source: createNoopSigner(vault),
            destination: alice.address,
            amount: 1n,
          }),
        ],
      })
      .sendTransaction();
    await instructions
      .proposalCreate({ multisig, creator: alice, rentPayer: client.payer, transactionIndex })
      .sendTransaction();
    await approve(multisig, transactionIndex, [alice]);

    // `isSquadsMultisigError` needs the transaction message to map the failing instruction index
    // to a program, so plan first and send that same message.
    const approveAgain = instructions.proposalApprove({
      multisig,
      member: alice,
      transactionIndex,
    });
    const message = await approveAgain.planTransaction();
    const error = await client.sendTransaction(message).then(
      () => undefined,
      (e: unknown) => e,
    );

    // The program error sits below the send failure and the simulation failure in the cause chain.
    let cause = error;
    while (
      cause &&
      !isSquadsMultisigError(cause, message, SQUADS_MULTISIG_ERROR__ALREADY_APPROVED, programConfig)
    ) {
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(cause, `unexpected error: ${String(error)}`).toBeDefined();
    expect(getSquadsMultisigErrorMessage(SQUADS_MULTISIG_ERROR__ALREADY_APPROVED)).toBe(
      'Member already approved the transaction',
    );
  });
});
