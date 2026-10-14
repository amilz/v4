import { getTransactionSize, getTransactionSizeLimit, type Transaction } from '@solana/kit';
import type { VaultTransactionMessage } from './generated';

type MessageHeader = Pick<
  VaultTransactionMessage,
  'numSigners' | 'numWritableSigners' | 'numWritableNonSigners' | 'accountKeys'
>;

/** Whether the static account key at `index` is writable. */
export function isStaticWritableIndex(message: MessageHeader, index: number): boolean {
  if (index >= message.accountKeys.length) return false;
  if (index < message.numWritableSigners) return true;
  if (index >= message.numSigners) {
    return index - message.numSigners < message.numWritableNonSigners;
  }
  return false;
}

/** Whether the static account key at `index` is a signer. */
export function isSignerIndex(message: Pick<MessageHeader, 'numSigners'>, index: number): boolean {
  return index < message.numSigners;
}

/**
 * Returns how many bytes of memo can be added to a transaction built without one. Reserves the
 * 4-byte string length prefix and 1 extra byte in case the instruction data length switches to
 * a 2-byte compact-u16 encoding.
 */
export function getAvailableMemoSize(transactionWithoutMemo: Transaction): number {
  return (
    getTransactionSizeLimit(transactionWithoutMemo) -
    getTransactionSize(transactionWithoutMemo) -
    4 -
    1
  );
}
