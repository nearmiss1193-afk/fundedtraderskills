const failedAccounts = new Set<string>();

export function markAccountFailed(accountId: string, reason: string) {
  failedAccounts.add(accountId);
  console.log(`[apex] Account ${accountId} marked FAILED: ${reason}`);
}

export function resetAccountStatus(accountId: string) {
  failedAccounts.delete(accountId);
  console.log(`[apex] Account ${accountId} status reset to active`);
}

export function isAccountFailed(accountId: string): boolean {
  return failedAccounts.has(accountId);
}

export function getFailedAccountSet(): Set<string> {
  return failedAccounts;
}
