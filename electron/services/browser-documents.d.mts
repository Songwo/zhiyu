import type { DocumentAsset } from "../../src/lib/documents";
export function browserDocument(input: { url: string; title: string; text: string }):
  Omit<DocumentAsset, "createdAt" | "updatedAt"> & { createOnly: true };
