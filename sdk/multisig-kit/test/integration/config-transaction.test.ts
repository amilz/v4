import { generateKeyPairSigner, type Address } from '@solana/kit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ConfigActionArgs,
  fetchConfigTransaction,
  fetchProposal,
  findProposalPda,
  findTransactionPda,
  getConfigTransactionCreateInstructionAsync,
  getConfigTransactionExecuteInstructionAsync,
  getProposalApproveInstructionAsync,
  getProposalCancelV2InstructionAsync,
  getProposalCreateInstructionAsync,
  getProposalRejectInstructionAsync,
  SQUADS_MULTISIG_ERROR__ALREADY_APPROVED,
  SQUADS_MULTISIG_ERROR__INVALID_PROPOSAL_STATUS,
  SQUADS_MULTISIG_ERROR__NOT_A_MEMBER,
  SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
  createPermissions,
  Permission,
} from '../../src';
import { createTestContext, programConfig, type TestMembers } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('autonomous multisig config transaction', () => {
  let members: TestMembers;
  let multisig: Address;

  async function createConfigTransactionWithProposal(actions: ConfigActionArgs[]) {
    const transactionIndex = (await ctx.getMultisig(multisig)).transactionIndex + 1n;
    await ctx.send([
      await getConfigTransactionCreateInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          actions,
          transactionIndex,
        },
        programConfig,
      ),
      await getProposalCreateInstructionAsync(
        { multisig, creator: members.proposer, rentPayer: ctx.client.payer, transactionIndex },
        programConfig,
      ),
    ]);
    return transactionIndex;
  }

  function vote(
    kind: 'approve' | 'reject' | 'cancel',
    member: typeof members.voter,
    transactionIndex: bigint,
  ) {
    const input = { multisig, member, transactionIndex };
    if (kind === 'approve') return getProposalApproveInstructionAsync(input, programConfig);
    if (kind === 'reject') return getProposalRejectInstructionAsync(input, programConfig);
    return getProposalCancelV2InstructionAsync(input, programConfig);
  }

  async function getProposal(transactionIndex: bigint) {
    const [proposal] = await findProposalPda({ multisig, transactionIndex }, programConfig);
    return (await fetchProposal(ctx.client.rpc, proposal)).data;
  }

  beforeEach(async () => {
    members = await ctx.generateMembers();
    multisig = await ctx.createMultisig({ members: ctx.memberArgs(members), threshold: 2 });
  });

  it('creates, approves and executes AddMember + ChangeThreshold', async () => {
    const newMember = await generateKeyPairSigner();
    const actions: ConfigActionArgs[] = [
      {
        __kind: 'AddMember',
        newMember: { key: newMember.address, permissions: createPermissions([Permission.Vote]) },
      },
      { __kind: 'ChangeThreshold', newThreshold: 3 },
    ];
    const transactionIndex = await createConfigTransactionWithProposal(actions);
    expect(transactionIndex).toBe(1n);

    const [transactionPda] = await findTransactionPda(
      { multisig, transactionIndex: 1n },
      programConfig,
    );
    const configTransaction = await fetchConfigTransaction(ctx.client.rpc, transactionPda);
    expect(configTransaction.programAddress).toBe(programConfig.programAddress);
    expect(configTransaction.data).toMatchObject({
      multisig,
      creator: members.proposer.address,
      index: 1n,
      actions,
    });
    expect((await getProposal(1n)).status.__kind).toBe('Active');

    await ctx.send([await vote('approve', members.voter, 1n)]);
    await ctx.expectProgramError(
      [await vote('approve', members.voter, 1n)],
      SQUADS_MULTISIG_ERROR__ALREADY_APPROVED,
    );
    await ctx.send([await vote('approve', members.almighty, 1n)]);

    const approved = await getProposal(1n);
    expect(approved.status.__kind).toBe('Approved');
    expect(approved.approved).toEqual(
      expect.arrayContaining([members.voter.address, members.almighty.address]),
    );

    await ctx.send([
      await getConfigTransactionExecuteInstructionAsync(
        {
          multisig,
          member: members.executor,
          rentPayer: ctx.client.payer,
          transactionIndex: 1n,
        },
        programConfig,
      ),
    ]);

    expect((await getProposal(1n)).status.__kind).toBe('Executed');
    const data = await ctx.getMultisig(multisig);
    expect(data.threshold).toBe(3);
    expect(data.members).toContainEqual({
      key: newMember.address,
      permissions: createPermissions([Permission.Vote]),
    });
    expect(data.staleTransactionIndex).toBe(1n);
  });

  it('rejects votes from non-members and members without Vote permission', async () => {
    const transactionIndex = await createConfigTransactionWithProposal([
      { __kind: 'SetTimeLock', newTimeLock: 10 },
    ]);
    const outsider = await generateKeyPairSigner();

    await ctx.expectProgramError(
      [await vote('approve', outsider, transactionIndex)],
      SQUADS_MULTISIG_ERROR__NOT_A_MEMBER,
    );
    await ctx.expectProgramError(
      [await vote('approve', members.proposer, transactionIndex)],
      SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
    );
  });

  it('marks the proposal Rejected once the rejection cutoff is reached', async () => {
    const transactionIndex = await createConfigTransactionWithProposal([
      { __kind: 'SetTimeLock', newTimeLock: 10 },
    ]);

    await ctx.send([await vote('reject', members.voter, transactionIndex)]);

    const proposal = await getProposal(transactionIndex);
    expect(proposal.status.__kind).toBe('Rejected');
    expect(proposal.rejected).toEqual([members.voter.address]);
    await ctx.expectProgramError(
      [await vote('approve', members.almighty, transactionIndex)],
      SQUADS_MULTISIG_ERROR__INVALID_PROPOSAL_STATUS,
    );
  });

  it('cancels an approved proposal', async () => {
    const transactionIndex = await createConfigTransactionWithProposal([
      { __kind: 'SetTimeLock', newTimeLock: 10 },
    ]);
    await ctx.send([
      await vote('approve', members.voter, transactionIndex),
      await vote('approve', members.almighty, transactionIndex),
    ]);

    await ctx.send([await vote('cancel', members.voter, transactionIndex)]);
    expect((await getProposal(transactionIndex)).status.__kind).toBe('Approved');
    await ctx.send([await vote('cancel', members.almighty, transactionIndex)]);

    const proposal = await getProposal(transactionIndex);
    expect(proposal.status.__kind).toBe('Cancelled');
    await ctx.expectProgramError(
      [
        await getConfigTransactionExecuteInstructionAsync(
          { multisig, member: members.executor, transactionIndex },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__INVALID_PROPOSAL_STATUS,
    );
  });
});

describe('immediate execution', () => {
  it('creates, proposes, approves and executes a config transaction in one Solana transaction', async () => {
    const members = await ctx.generateMembers();
    const multisig = await ctx.createMultisig({ members: ctx.memberArgs(members), threshold: 1 });
    const input = { multisig, transactionIndex: 1n };

    await ctx.send([
      await getConfigTransactionCreateInstructionAsync(
        {
          ...input,
          creator: members.almighty,
          rentPayer: ctx.client.payer,
          actions: [{ __kind: 'ChangeThreshold', newThreshold: 2 }],
        },
        programConfig,
      ),
      await getProposalCreateInstructionAsync(
        { ...input, creator: members.almighty, rentPayer: ctx.client.payer },
        programConfig,
      ),
      await getProposalApproveInstructionAsync(
        { ...input, member: members.almighty },
        programConfig,
      ),
      await getConfigTransactionExecuteInstructionAsync(
        { ...input, member: members.almighty, rentPayer: ctx.client.payer },
        programConfig,
      ),
    ]);

    expect((await ctx.getMultisig(multisig)).threshold).toBe(2);
  });
});
