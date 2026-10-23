import { useAppStore } from "@/lib/store";

const FIELD_PREFIX = "field:";
export const fieldKey = (id: string) => `${FIELD_PREFIX}${id}`;

/** 把表单里的 `field:<id>` 收回成资产的 fields。 */
export function fieldsFromForm(form: Record<string, string>, typeId: string | undefined) {
  if (!typeId) return undefined;
  const type = useAppStore.getState().assetTypes.find((item) => item.id === typeId);
  if (!type) return undefined;
  const fields: Record<string, string> = {};
  for (const field of type.fields) {
    const value = (form[fieldKey(field.id)] ?? "").trim();
    if (value) fields[field.id] = value;
  }
  return fields;
}
