import type { DocumentAccountCandidate } from "../../src/lib/document-accounts";

/** 浏览器与桌面共用的 Markdown 账号解析器。 */
export function parseDocumentAccounts(source: string): {
  candidates: DocumentAccountCandidate[];
  warnings: string[];
};
