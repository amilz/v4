import { afterAll, describe, expect, it } from 'vitest';
import {
  fetchMultisig,
  getConfigTransactionCreateInstructionAsync,
  getConfigTransactionExecuteInstructionAsync,
  getProposalApproveInstructionAsync,
  getProposalCreateInstructionAsync,
  SQUADS_MULTISIG_ERROR__TIME_LOCK_NOT_RELEASED,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('time lock', () => {
  it('blocks execution until the time lock is released', async () => {
    const timeLock = 3600;
    const members = await ctx.generateMembers();
    const multisig = await ctx.createMultisig({
      members: ctx.memberArgs(members),
      threshold: 1,
      timeLock,
    });
    const transactionIndex = 1n;
    ctx.fund(members.almighty);

    await ctx.send(
      [
        await getConfigTransactionCreateInstructionAsync(
          {
            multisig,
            creator: members.almighty,
            actions: [{ __kind: 'SetTimeLock', newTimeLock: 0 }],
            transactionIndex,
          },
          programConfig,
        ),
        await getProposalCreateInstructionAsync(
          { multisig, creator: members.almighty, transactionIndex },
          programConfig,
        ),
        await getProposalApproveInstructionAsync(
          { multisig, member: members.almighty, transactionIndex },
          programConfig,
        ),
      ],
      members.almighty,
    );

    const execute = await getConfigTransactionExecuteInstructionAsync(
      { multisig, member: members.almighty, transactionIndex },
      programConfig,
    );
    await ctx.expectProgramError([execute], SQUADS_MULTISIG_ERROR__TIME_LOCK_NOT_RELEASED);

    await ctx.timeTravelSeconds(timeLock + 1);
    await ctx.send([execute]);

    expect((await fetchMultisig(ctx.client.rpc, multisig)).data.timeLock).toBe(0);
  });
});
