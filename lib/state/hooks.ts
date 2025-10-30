// All wallet state is managed in the browser (dgen-ui)
// These hooks are kept for backward compatibility but do nothing

export async function initializeUserState(userId: string): Promise<void> {
  // Wallet state managed in browser
}

export async function getUserBalance(userId: string): Promise<any> {
  // Balance managed in browser
  return null;
}

export async function getUserPayments(userId: string, filter?: any): Promise<any[]> {
  // Payments managed in browser
  return [];
}

export async function refreshUserState(userId: string): Promise<void> {
  // State managed in browser
}

export async function cleanupUserState(userId: string): Promise<void> {
  // Cleanup handled in browser
}
