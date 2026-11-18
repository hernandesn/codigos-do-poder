export interface TelegramDb {
  issueCode(userId: string, hash: string, issuedAt: number): Promise<boolean>
  revokeCodes(userId: string): Promise<void>
  consumeCode(telegramId: string, hash: string): Promise<boolean>
  unlink(telegramId: string): Promise<void>
  linkedUser(telegramId: string): Promise<string | null>
  claimUpdate(updateId: number): Promise<boolean>
  rateTouch(telegramId: string): Promise<boolean>
  beginSession(hash: string, telegramId: string, proofHash: string, expiresAt: number): Promise<boolean>
  sessionUser(hash: string, telegramId: string, proofHash: string): Promise<{ok:boolean;userId:string|null}>
}
