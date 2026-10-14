import { generateKeyPairSigner } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fetchProgramConfig,
  findProgramConfigPda,
  getProgramConfigInitInstructionAsync,
  SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const ctx = await createTestContext({ initProgramConfig: false });
afterAll(() => ctx.client.surfnet.stop());

describe('programConfigInit', () => {
  it('rejects an initializer other than the hardcoded one', async () => {
    const fakeInitializer = await generateKeyPairSigner();
    ctx.fund(fakeInitializer);
    await ctx.expectProgramError(
      [
        await getProgramConfigInitInstructionAsync(
          {
            initializer: fakeInitializer,
            authority: ctx.programConfigAuthority.address,
            multisigCreationFee: 0,
            treasury: ctx.treasury,
          },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
      fakeInitializer,
    );
  });

  it('initializes the program config at the custom program address', async () => {
    await ctx.initProgramConfigAccount();

    const [programConfigPda] = await findProgramConfigPda(programConfig);
    const account = await fetchProgramConfig(ctx.client.rpc, programConfigPda);
    expect(account.programAddress).toBe(programConfig.programAddress);
    expect(account.data.authority).toBe(ctx.programConfigAuthority.address);
    expect(account.data.treasury).toBe(ctx.treasury);
    expect(account.data.multisigCreationFee).toBe(0n);
  });
});
