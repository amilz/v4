import { createHash } from 'node:crypto';
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getUtf8Encoder,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  type CompactTransactionMessage,
  findMultisigPda,
  findProposalPda,
  getCompactTransactionMessageCodec,
  getMultisigCreateV2InstructionAsync,
  getProposalApproveInstructionAsync,
  SQUADS_MULTISIG_PROGRAM_ADDRESS,
} from '../../src';

const TESTING_PROGRAM_ADDRESS = address('GyhGAqjokLwF9UXdQ2dR5Zwiup242j4mX4J1tSMKyAmD');
const createKey = address('BrQAbGdWQ9YUHmWWgKFdFe4miTURH71jkYFPXfaosqDv');
const utf8 = getUtf8Encoder();

function anchorDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

describe('generated client', () => {
  it('uses the mainnet program address by default', () => {
    expect(SQUADS_MULTISIG_PROGRAM_ADDRESS).toBe('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
  });

  it.each([SQUADS_MULTISIG_PROGRAM_ADDRESS, TESTING_PROGRAM_ADDRESS])(
    'derives the multisig PDA for %s',
    async (programAddress) => {
      const expected = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          utf8.encode('multisig'),
          utf8.encode('multisig'),
          getAddressEncoder().encode(createKey),
        ],
      });
      expect(await findMultisigPda({ createKey }, { programAddress })).toEqual(expected);
    },
  );

  it('round-trips a compact transaction message', () => {
    const message: CompactTransactionMessage = {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 1,
      accountKeys: [createKey, TESTING_PROGRAM_ADDRESS],
      instructions: [{ programIdIndex: 1, accountIndexes: [0], data: new Uint8Array([1, 2, 3]) }],
      addressTableLookups: [
        { accountKey: SQUADS_MULTISIG_PROGRAM_ADDRESS, writableIndexes: [2], readonlyIndexes: [] },
      ],
    };
    const codec = getCompactTransactionMessageCodec();
    const bytes = codec.encode(message);
    expect(bytes.length).toBe(3 + 1 + 64 + 1 + (1 + 1 + 1 + 2 + 3) + 1 + (32 + 1 + 1 + 1));
    expect(codec.decode(bytes)).toEqual(message);
  });

  it('prefixes instruction data with the Anchor discriminator', async () => {
    const instruction = await getMultisigCreateV2InstructionAsync({
      treasury: createKey,
      createKey: await generateKeyPairSigner(),
      creator: await generateKeyPairSigner(),
      configAuthority: null,
      threshold: 1,
      members: [],
      timeLock: 0,
      rentCollector: null,
    });
    expect(instruction.data.subarray(0, 8)).toEqual(anchorDiscriminator('multisig_create_v2'));
  });

  it('derives default PDAs with a custom program address', async () => {
    const multisig = address('11111111111111111111111111111112');
    const instruction = await getProposalApproveInstructionAsync(
      { multisig, member: await generateKeyPairSigner(), transactionIndex: 7n },
      { programAddress: TESTING_PROGRAM_ADDRESS },
    );
    const [expectedProposal] = await getProgramDerivedAddress({
      programAddress: TESTING_PROGRAM_ADDRESS,
      seeds: [
        utf8.encode('multisig'),
        getAddressEncoder().encode(multisig),
        utf8.encode('transaction'),
        getU64Encoder().encode(7n),
        utf8.encode('proposal'),
      ],
    });
    expect(instruction.programAddress).toBe(TESTING_PROGRAM_ADDRESS);
    expect(instruction.accounts[2].address).toBe(expectedProposal);
    const [mainnetProposal] = await findProposalPda({ multisig, transactionIndex: 7n });
    expect(instruction.accounts[2].address).not.toBe(mainnetProposal);
  });
});
