import {
  address,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Decoder,
  lamports,
  none,
  type Address,
  type GetProgramAccountsApi,
  type GetProgramAccountsMemcmpFilter,
  type ReadonlyUint8Array,
  type Rpc,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  allPermissions,
  fetchBatchAccounts,
  fetchConfigTransactionAccounts,
  fetchMultisigAccounts,
  fetchProposalAccounts,
  fetchSpendingLimitAccounts,
  fetchTransactionBufferAccounts,
  fetchVaultTransactionAccounts,
  getBatchEncoder,
  getConfigTransactionEncoder,
  getMultisigEncoder,
  getProposalEncoder,
  getSpendingLimitEncoder,
  getTransactionBufferEncoder,
  getVaultTransactionEncoder,
  SQUADS_MULTISIG_PROGRAM_ADDRESS,
  type ProposalStatusArgs,
} from '../../src';

type FakeAccount = { pubkey: Address; data: ReadonlyUint8Array };
type GetProgramAccountsConfig = Parameters<
  Rpc<GetProgramAccountsApi>['getProgramAccounts']
>[1] & {};

/** Minimal in-memory `getProgramAccounts` that applies memcmp filters to raw account data. */
function createFakeRpc(accounts: FakeAccount[]) {
  const calls: { program: Address; config: GetProgramAccountsConfig }[] = [];
  const rpc = {
    getProgramAccounts(program: Address, config: GetProgramAccountsConfig) {
      calls.push({ program, config });
      const filters = (config.filters ?? []) as GetProgramAccountsMemcmpFilter[];
      const matches = accounts.filter(({ data }) =>
        filters.every(({ memcmp: { offset, bytes } }) => {
          const expected = getBase58Encoder().encode(bytes);
          const actual = data.slice(Number(offset), Number(offset) + expected.length);
          return actual.length === expected.length && actual.every((b, i) => b === expected[i]);
        }),
      );
      return {
        send: async () =>
          matches.map(({ pubkey, data }) => ({
            pubkey,
            account: {
              data: [getBase64Decoder().decode(data), 'base64'],
              executable: false,
              lamports: lamports(1n),
              owner: program,
              space: BigInt(data.length),
            },
          })),
      };
    },
  } as unknown as Rpc<GetProgramAccountsApi>;
  return { rpc, calls };
}

const randomAddress = async () => (await generateKeyPairSigner()).address;

describe('gpa helpers', () => {
  it('always filters by discriminator and defaults to the program address', async () => {
    const { rpc, calls } = createFakeRpc([]);
    await fetchMultisigAccounts(rpc);
    expect(calls[0].program).toBe(SQUADS_MULTISIG_PROGRAM_ADDRESS);
    expect(calls[0].config.encoding).toBe('base64');
    expect(calls[0].config.filters).toEqual([
      {
        memcmp: {
          offset: 0n,
          bytes: expect.any(String),
          encoding: 'base58',
        },
      },
    ]);

    const programAddress = address('GyhGAqjokLwF9UXdQ2dR5Zwiup242j4mX4J1tSMKyAmD');
    await fetchProposalAccounts(rpc, {}, { programAddress });
    expect(calls[1].program).toBe(programAddress);
  });

  it('filters multisigs by createKey and configAuthority', async () => {
    const [createKeyA, createKeyB, authority] = await Promise.all(
      Array.from({ length: 3 }, randomAddress),
    );
    const multisig = (createKey: Address, configAuthority: Address) =>
      getMultisigEncoder().encode({
        createKey,
        configAuthority,
        threshold: 1,
        timeLock: 0,
        transactionIndex: 0,
        staleTransactionIndex: 0,
        rentCollector: none(),
        bump: 255,
        members: [{ key: createKey, permissions: allPermissions() }],
      });
    const accounts = await Promise.all(
      [
        multisig(createKeyA, authority),
        multisig(createKeyB, authority),
        multisig(authority, createKeyA),
        getProposalEncoder().encode(proposal(createKeyA, { __kind: 'Active', timestamp: 0 })),
      ].map(async (data) => ({ pubkey: await randomAddress(), data })),
    );
    const { rpc } = createFakeRpc(accounts);

    const byCreateKey = await fetchMultisigAccounts(rpc, { createKey: createKeyA });
    expect(byCreateKey.map((a) => a.address)).toEqual([accounts[0].pubkey]);
    expect(byCreateKey[0].data.createKey).toBe(createKeyA);

    const byAuthority = await fetchMultisigAccounts(rpc, { configAuthority: authority });
    expect(byAuthority.map((a) => a.address)).toEqual([accounts[0].pubkey, accounts[1].pubkey]);

    expect(await fetchMultisigAccounts(rpc)).toHaveLength(3);
  });

  it('filters proposals by multisig and status', async () => {
    const [multisigA, multisigB] = await Promise.all([randomAddress(), randomAddress()]);
    const statuses: ProposalStatusArgs[] = [
      { __kind: 'Draft', timestamp: 1 },
      { __kind: 'Active', timestamp: 1 },
      { __kind: 'Rejected', timestamp: 1 },
      { __kind: 'Approved', timestamp: 1 },
      { __kind: 'Executing' },
      { __kind: 'Executed', timestamp: 1 },
      { __kind: 'Cancelled', timestamp: 1 },
    ];
    const accounts = await Promise.all(
      [
        ...statuses.map((status) => proposal(multisigA, status)),
        proposal(multisigB, { __kind: 'Active', timestamp: 1 }),
      ].map(async (args) => ({
        pubkey: await randomAddress(),
        data: getProposalEncoder().encode(args),
      })),
    );
    const { rpc } = createFakeRpc(accounts);

    expect(await fetchProposalAccounts(rpc, { multisig: multisigA })).toHaveLength(7);
    for (const { __kind } of statuses) {
      const [match] = await fetchProposalAccounts(rpc, { multisig: multisigA, status: __kind });
      expect(match.data.status.__kind).toBe(__kind);
    }
    expect(await fetchProposalAccounts(rpc, { status: 'Active' })).toHaveLength(2);
  });

  it('filters transactions, batches and buffers by multisig and creator', async () => {
    const [multisig, creator, other] = await Promise.all(Array.from({ length: 3 }, randomAddress));
    const header = { multisig, creator, index: 1, bump: 255 };
    const message = {
      numSigners: 0,
      numWritableSigners: 0,
      numWritableNonSigners: 0,
      accountKeys: [],
      instructions: [],
      addressTableLookups: [],
    };
    const accounts = await Promise.all(
      [
        getVaultTransactionEncoder().encode({
          ...header,
          vaultIndex: 0,
          vaultBump: 255,
          ephemeralSignerBumps: new Uint8Array(),
          message,
        }),
        getVaultTransactionEncoder().encode({
          ...header,
          creator: other,
          vaultIndex: 0,
          vaultBump: 255,
          ephemeralSignerBumps: new Uint8Array(),
          message,
        }),
        getConfigTransactionEncoder().encode({ ...header, actions: [] }),
        getBatchEncoder().encode({
          ...header,
          vaultIndex: 0,
          vaultBump: 255,
          size: 0,
          executedTransactionIndex: 0,
        }),
        getTransactionBufferEncoder().encode({
          multisig,
          creator,
          bufferIndex: 0,
          vaultIndex: 0,
          finalBufferHash: new Uint8Array(32),
          finalBufferSize: 0,
          buffer: new Uint8Array(),
        }),
      ].map(async (data) => ({ pubkey: await randomAddress(), data })),
    );
    const { rpc } = createFakeRpc(accounts);

    expect(await fetchVaultTransactionAccounts(rpc, { multisig })).toHaveLength(2);
    const byCreator = await fetchVaultTransactionAccounts(rpc, { multisig, creator });
    expect(byCreator.map((a) => a.address)).toEqual([accounts[0].pubkey]);
    expect(await fetchVaultTransactionAccounts(rpc, { creator: other })).toHaveLength(1);
    expect((await fetchConfigTransactionAccounts(rpc, { multisig, creator }))[0].address).toBe(
      accounts[2].pubkey,
    );
    expect((await fetchBatchAccounts(rpc, { multisig, creator }))[0].address).toBe(
      accounts[3].pubkey,
    );
    expect((await fetchTransactionBufferAccounts(rpc, { multisig, creator }))[0].address).toBe(
      accounts[4].pubkey,
    );
    expect(await fetchConfigTransactionAccounts(rpc, { creator: other })).toHaveLength(0);
  });

  it('filters spending limits by multisig, vaultIndex and mint', async () => {
    const [multisig, mintA, mintB] = await Promise.all(Array.from({ length: 3 }, randomAddress));
    const spendingLimit = (vaultIndex: number, mint: Address) =>
      getSpendingLimitEncoder().encode({
        multisig,
        createKey: multisig,
        vaultIndex,
        mint,
        amount: 1,
        period: 0,
        remainingAmount: 1,
        lastReset: 0,
        bump: 255,
        members: [],
        destinations: [],
      });
    const accounts = await Promise.all(
      [spendingLimit(0, mintA), spendingLimit(1, mintA), spendingLimit(1, mintB)].map(
        async (data) => ({ pubkey: await randomAddress(), data }),
      ),
    );
    const { rpc } = createFakeRpc(accounts);

    expect(await fetchSpendingLimitAccounts(rpc, { multisig })).toHaveLength(3);
    expect(await fetchSpendingLimitAccounts(rpc, { vaultIndex: 1 })).toHaveLength(2);
    const [match] = await fetchSpendingLimitAccounts(rpc, { multisig, vaultIndex: 1, mint: mintB });
    expect(match.address).toBe(accounts[2].pubkey);
    expect(match.data.mint).toBe(mintB);
  });
});

function proposal(multisig: Address, status: ProposalStatusArgs) {
  return {
    multisig,
    transactionIndex: 1,
    status,
    bump: 255,
    approved: [],
    rejected: [],
    cancelled: [],
  };
}
