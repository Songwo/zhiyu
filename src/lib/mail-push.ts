export type MailPushProvider = "telegram" | "serverchan" | "wecom" | "wxpusher";

export interface MailPushConfig {
  enabled: boolean;
  provider: MailPushProvider;
  destination: string;
  hasToken: boolean;
  mailboxIds: string[];
  intervalMinutes: number;
  /** 续费与备忘提醒也推送到这个渠道。 */
  reminders?: boolean;
}

export interface MailPushInput extends Omit<MailPushConfig, "hasToken"> {
  token?: string;
  clearToken?: boolean;
}

export interface MailPushBridge {
  config(): Promise<MailPushConfig>;
  save(input: MailPushInput): Promise<MailPushConfig>;
  test(): Promise<{ ok: true }>;
}
