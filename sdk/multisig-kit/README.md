# @sqds/multisig-kit

Proof-of-concept [Solana Kit](https://github.com/anza-xyz/kit) SDK for the Squads Multisig Program v4, generated with [Codama](https://github.com/codama-idl/codama) from [`../multisig/idl/squads_multisig_program.json`](../multisig/idl/squads_multisig_program.json).

- `@solana/kit` (`^8.5.0`) is the only runtime dependency (a peer dependency). No Metaplex/beet, `bn.js`, `buffer` or web3.js v1.
- Works with `@solana/web3.js` v3 (`next` / `@3`), which is built on Kit: its `Transaction.add()` accepts the instructions this SDK returns and `PublicKey#address` is a Kit `Address`.
- Not published yet (`"private": true`).

## What's generated vs. hand-written

| Area                                                                                               | Source                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Instructions, accounts, types, errors, base program plugin                                         | Codama (`src/generated`, from the IDL)         |
| PDA finders (`findMultisigPda`, `findVaultPda`, `findProposalPda`, …) and instruction PDA defaults | Codama, configured in `scripts/generate.ts`    |
| Compact transaction message codec (`getCompactTransactionMessageCodec`)                            | Codama, type defined in `scripts/generate.ts`  |
| `compileCompactTransactionMessage`, execute remaining accounts, `build*Instruction` helpers        | Hand-written (`src/*.ts`) using Kit primitives |
| `Permission` / `createPermissions` / `allPermissions` / `hasPermission`, memo size helpers         | Hand-written                                   |
| `getProgramAccounts` queries (`fetchMultisigAccounts`, `fetchProposalAccounts`, …)                 | Hand-written                                   |
| `squadsMultisigProgram()` client plugin (wraps the generated one, see below)                       | Hand-written (`src/plugin.ts`)                 |

The legacy Anchor 0.29 IDL carries no PDA seeds, so `scripts/generate.ts` adds the program's PDAs and wires them as instruction account defaults. The generated `get*InstructionAsync` builders derive `programConfig`, `multisig`, `transaction`, `proposal`, `batch`, `transactionBuffer` and `vault` accounts from `createKey`, `transactionIndex`, `batchIndex`, `bufferIndex` and `vaultIndex`.

## Usage

### With a Kit client and the program plugin

```ts
import { createClient } from '@solana/kit';
import { solanaMainnetRpc } from '@solana/kit-plugin-rpc';
import { payer } from '@solana/kit-plugin-signer';
import { allPermissions, squadsMultisigProgram } from '@sqds/multisig-kit';

const client = createClient()
  .use(payer(mySigner))
  .use(solanaMainnetRpc({ rpcUrl: 'https://api.mainnet-beta.solana.com' }))
  .use(squadsMultisigProgram());

const [multisig] = await client.squadsMultisig.pdas.multisig({ createKey: createKey.address });
await client.squadsMultisig.instructions
  .multisigCreateV2({
    treasury,
    createKey,
    creator: client.payer,
    configAuthority: null,
    threshold: 2,
    members: [alice, bob].map(({ address }) => ({ key: address, permissions: allPermissions() })),
    timeLock: 0,
    rentCollector: null,
  })
  .sendTransaction();

const { data } = await client.squadsMultisig.accounts.multisig.fetch(multisig);
```

Instruction methods return the instruction augmented with `.planTransaction()` and `.sendTransaction()`. The exported `squadsMultisigProgram()` wraps the Codama-generated plugin (same `accounts`, `pdas` and instructions) and replaces the instructions whose raw form is incomplete with the `build*Instruction` helpers:

| Plugin instruction         | Difference from the raw generated instruction                                   |
| -------------------------- | ------------------------------------------------------------------------------- |
| `vaultTransactionCreate`   | Takes `instructions` (+ optional lookup tables) instead of `transactionMessage` |
| `batchAddTransaction`      | Takes `instructions` and `vaultIndex` instead of `transactionMessage`           |
| `vaultTransactionExecute`  | Fetches the stored message with `client.rpc` and appends its remaining accounts |
| `batchExecuteTransaction`  | Fetches the batch and its transaction and appends the remaining accounts        |
| `configTransactionExecute` | Takes `spendingLimits` and passes them as remaining accounts                    |

```ts
const { instructions, gpa } = client.squadsMultisig;

await instructions
  .vaultTransactionCreate({
    multisig,
    creator: alice,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionIndex,
    instructions: [
      getTransferSolInstruction({ source: createNoopSigner(vault), destination, amount }),
    ],
  })
  .sendTransaction();
// ...proposalCreate / proposalApprove, then:
await instructions
  .vaultTransactionExecute({ multisig, member, transactionIndex })
  .sendTransaction();

const approved = await gpa.proposals({ multisig, status: 'Approved' });
const limits = await gpa.spendingLimits({ multisig, vaultIndex: 0 });
```

`gpa` exposes every `fetch*Accounts` query bound to `client.rpc` (`multisigs`, `proposals`, `vaultTransactions`, `configTransactions`, `batches`, `vaultBatchTransactions`, `spendingLimits`, `transactionBuffers`, `programConfigs`), so the client RPC must also support `getProgramAccounts`. The plugin execute instructions don't compress the outer transaction with lookup tables; when the inner message uses them and the outer transaction is too large, use `buildVaultTransactionExecuteInstruction` / `buildBatchExecuteTransactionInstruction` and compress with the returned `addressesByLookupTableAddress`.

The plugin targets the mainnet program address by default; pass `squadsMultisigProgram({ programAddress })` to target another deployment. See `test/integration/plugin.test.ts` for vault, batch and config transaction flows and error decoding with `isSquadsMultisigError`.

### Create a multisig

```ts
import { generateKeyPairSigner } from '@solana/kit';
import {
  allPermissions,
  createPermissions,
  fetchMultisig,
  findMultisigPda,
  getMultisigCreateV2InstructionAsync,
  Permission,
} from '@sqds/multisig-kit';

const createKey = await generateKeyPairSigner();
const createMultisig = await getMultisigCreateV2InstructionAsync({
  createKey,
  creator: payer,
  treasury, // `treasury` from the ProgramConfig account
  configAuthority: null,
  rentCollector: null,
  threshold: 2,
  timeLock: 0,
  members: [
    { key: alice.address, permissions: allPermissions() },
    { key: bob.address, permissions: createPermissions([Permission.Vote, Permission.Execute]) },
  ],
});
// Send `createMultisig` with your Kit transaction pipeline or client.

const [multisig] = await findMultisigPda({ createKey: createKey.address });
const { data } = await fetchMultisig(rpc, multisig);
```

### Vault transaction lifecycle

Inner instructions are regular Kit instructions where the vault is the signer. Use `createNoopSigner(vault)` for signer inputs that belong to the vault (and to ephemeral signer PDAs).

```ts
import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner } from '@solana/kit';
import {
  buildVaultTransactionCreateInstruction,
  buildVaultTransactionExecuteInstruction,
  fetchMultisig,
  findVaultPda,
  getProposalApproveInstructionAsync,
  getProposalCreateInstructionAsync,
} from '@sqds/multisig-kit';

const [vault] = await findVaultPda({ multisig, vaultIndex: 0 });
const transactionIndex = (await fetchMultisig(rpc, multisig)).data.transactionIndex + 1n;

const instructions = [
  await buildVaultTransactionCreateInstruction({
    multisig,
    creator: alice,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionIndex,
    instructions: [
      getTransferSolInstruction({
        source: createNoopSigner(vault),
        destination,
        amount: 1_000_000n,
      }),
    ],
    // addressesByLookupTableAddress, // optional: load inner accounts and program ids from ALTs
  }),
  await getProposalCreateInstructionAsync({ multisig, creator: alice, transactionIndex }),
  await getProposalApproveInstructionAsync({ multisig, member: alice, transactionIndex }),
];
// ...send, then once the threshold is reached:

const { instruction, addressesByLookupTableAddress } =
  await buildVaultTransactionExecuteInstruction({ rpc, multisig, member: bob, transactionIndex });
// Compress the outer message with `compressTransactionMessageUsingAddressLookupTables(message,
// addressesByLookupTableAddress)` when the inner message uses lookup tables.
```

`buildBatchAddTransactionInstruction` / `buildBatchExecuteTransactionInstruction` do the same for batches, and `buildConfigTransactionExecuteInstruction` passes spending limits touched by a config transaction as remaining accounts. For transaction buffers, encode `compileCompactTransactionMessage(...)` with `getCompactTransactionMessageEncoder()` and hash the bytes with SHA-256 for `finalBufferHash`.

### Custom program address

Every generated builder, PDA finder, `fetch*FromSeeds`, hand-written helper, the `squadsMultisigProgram()` plugin and `isSquadsMultisigError` accept `{ programAddress }`:

```ts
const config = { programAddress: address('GyhGAqjokLwF9UXdQ2dR5Zwiup242j4mX4J1tSMKyAmD') };
await findVaultPda({ multisig, vaultIndex: 0 }, config);
await getProposalApproveInstructionAsync({ multisig, member, transactionIndex }, config);
await buildVaultTransactionExecuteInstruction({ rpc, multisig, member, transactionIndex }, config);
const client = createClient()
  .use(payer(mySigner))
  .use(solanaDevnetRpc({ rpcUrl: 'https://api.devnet.solana.com' }))
  .use(squadsMultisigProgram(config));
isSquadsMultisigError(error, transactionMessage, SQUADS_MULTISIG_ERROR__ALREADY_APPROVED, config);
```

The plugin forwards its `programAddress` to every instruction, PDA and `gpa` query; a per-call config takes precedence. Except for the hand-written helpers, these overrides also accept an address-bearing object such as a web3.js `PublicKey`, as do the account addresses passed to generated `fetch*` helpers.

### With `@solana/web3.js` v3

web3.js v3 types plug straight in: `PublicKey#address` is a Kit `Address`, `Keypair` implements Kit's `KeyPairSigner`, and `Transaction.add()` / `TransactionMessage` accept the Kit instructions this SDK returns.

```ts
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const alice = Keypair.generate();
const instruction = await getProposalApproveInstructionAsync({
  multisig: new PublicKey(multisigAddress).address,
  member: alice,
  transactionIndex,
});
const message = new TransactionMessage({
  payerKey: alice.publicKey,
  recentBlockhash,
  instructions: [instruction],
}).compileToV0Message();
```

Inner instructions passed to `buildVaultTransactionCreateInstruction` must be Kit `Instruction`s; web3.js v3 has no `TransactionInstruction` → `Instruction` converter, so map `programId`, `keys` (to `AccountRole`) and `data` yourself (see `test/integration/web3js-v3-interop.test.ts`).

Known issue with `@solana/web3.js@3.0.2` + `@solana/kit@8.5`: legacy `Transaction.serialize()` (and `sendAndConfirmTransaction`) throws `SOLANA_ERROR__KEYS__VERIFICATION_REQUIRES_EXTRACTABLE_PUBLIC_KEY`, because web3.js imports public keys as non-extractable for signature verification. Use `VersionedTransaction`, or `serialize({ verifySignatures: false })` with `sendRawTransaction`.

## Migrating from `@sqds/multisig`

| `@sqds/multisig`                                                   | `@sqds/multisig-kit`                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `getMultisigPda`, `getVaultPda`, `getProposalPda`, …               | `findMultisigPda`, `findVaultPda`, `findProposalPda`, … (async, `[address, bump]`)    |
| `instructions.*` (PDA derivation wrappers)                         | `get*InstructionAsync`                                                                |
| `instructions.vaultTransactionCreate` / `batchAddTransaction`      | `buildVaultTransactionCreateInstruction` / `buildBatchAddTransactionInstruction`      |
| `instructions.vaultTransactionExecute` / `batchExecuteTransaction` | `buildVaultTransactionExecuteInstruction` / `buildBatchExecuteTransactionInstruction` |
| `instructions.configTransactionExecute({ spendingLimits })`        | `buildConfigTransactionExecuteInstruction({ spendingLimits })`                        |
| `utils.transactionMessageToMultisigTransactionMessageBytes`        | `getCompactTransactionMessageEncoder().encode(compileCompactTransactionMessage(...))` |
| `utils.accountsForTransactionExecute`                              | `getExecuteRemainingAccounts`                                                         |
| `accounts.Multisig.fromAccountAddress(connection, address)`        | `fetchMultisig(rpc, address)`                                                         |
| `accounts.Proposal.gpaBuilder().addFilter(...)`, …                 | `fetchProposalAccounts(rpc, { multisig, status })`, `fetchMultisigAccounts`, …        |
| `types.Permissions.fromPermissions([...])` / `.all()` / `.has()`   | `createPermissions([...])` / `allPermissions()` / `hasPermission()`                   |
| `errors.translateAndThrowAnchorError`                              | Kit `isProgramError` + `getSquadsMultisigErrorMessage`                                |
| `transactions.*`, `rpc.*`                                          | Kit transaction messages / client (`sendTransaction`)                                 |

The compact message compiler and execute remaining accounts are byte-for-byte checked against `@sqds/multisig@2.1.4` output in `test/unit/fixtures/legacy-compact-messages.json`.

## Development

Uses pnpm and lives outside the root yarn workspace (the root `resolutions` pin web3.js v1 and TypeScript 4.9).

```sh
pnpm install
pnpm generate          # regenerate src/generated from the IDL
pnpm build             # tsup → lib/ (esm + cjs + d.ts)
pnpm lint              # prettier --check + tsc --noEmit
pnpm test              # unit tests
pnpm build:program     # cargo-build-sbf: testing build in ../../target/deploy
pnpm test:integration  # Surfpool (@solana/surfpool) integration tests
```

Integration tests boot an in-process Surfnet per file, deploy the program built by `pnpm build:program`, and run against the testing program id `GyhGAqjokLwF9UXdQ2dR5Zwiup242j4mX4J1tSMKyAmD`.
