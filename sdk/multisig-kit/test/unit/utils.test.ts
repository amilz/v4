import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionSize,
  getTransactionSizeLimit,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  allPermissions,
  createPermissions,
  getAvailableMemoSize,
  getProposalApproveInstructionAsync,
  hasPermission,
  isSignerIndex,
  isStaticWritableIndex,
  Permission,
} from '../../src';

describe('permissions', () => {
  it('builds masks from permission lists', () => {
    expect(createPermissions([])).toEqual({ mask: 0 });
    expect(createPermissions([Permission.Initiate, Permission.Execute])).toEqual({ mask: 0b101 });
    expect(allPermissions()).toEqual({ mask: 0b111 });
  });

  it('checks for individual permissions', () => {
    const permissions = createPermissions([Permission.Vote]);
    expect(hasPermission(permissions, Permission.Vote)).toBe(true);
    expect(hasPermission(permissions, Permission.Initiate)).toBe(false);
    expect(hasPermission(allPermissions(), Permission.Execute)).toBe(true);
  });
});

describe('message index helpers', () => {
  const key = address('11111111111111111111111111111111');
  const message = {
    numSigners: 3,
    numWritableSigners: 2,
    numWritableNonSigners: 1,
    accountKeys: Array.from({ length: 6 }, () => key),
  };

  it('classifies static writable indexes', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((index) => isStaticWritableIndex(message, index))).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it('classifies signer indexes', () => {
    expect([0, 2, 3].map((index) => isSignerIndex(message, index))).toEqual([true, true, false]);
  });
});

describe('getAvailableMemoSize', () => {
  const programAddress = address('GyhGAqjokLwF9UXdQ2dR5Zwiup242j4mX4J1tSMKyAmD');
  const multisig = address('AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9');

  async function compileWithMemo(memo?: string) {
    const member = await generateKeyPairSigner();
    const instruction: Instruction = await getProposalApproveInstructionAsync(
      { multisig, member, transactionIndex: 1n, memo },
      { programAddress },
    );
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(member.address, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: '11111111111111111111111111111111' as Blockhash,
              lastValidBlockHeight: 0n,
            },
            m,
          ),
        (m) => appendTransactionMessageInstruction(instruction, m),
      ),
    );
  }

  it('returns the largest memo that still fits in the transaction', async () => {
    const available = getAvailableMemoSize(await compileWithMemo());
    expect(available).toBeGreaterThan(0);
    const fitting = await compileWithMemo('a'.repeat(available));
    expect(getTransactionSize(fitting)).toBeLessThanOrEqual(getTransactionSizeLimit(fitting));
    const overflowing = await compileWithMemo('a'.repeat(available + 2));
    expect(getTransactionSize(overflowing)).toBeGreaterThan(getTransactionSizeLimit(overflowing));
  });
});
