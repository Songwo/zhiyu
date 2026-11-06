/**
 * 先获得解锁许可并删除加密记录，失败或取消时保留资料入口。
 * @param {{id: string, requireUnlocked: () => Promise<boolean>, removeCredential: (key: string) => Promise<unknown>, removeAsset: (id: string) => void | Promise<unknown>}} options
 */
export async function deleteEncryptedAccount({
  id,
  requireUnlocked,
  removeCredential,
  removeAsset,
}) {
  if (!(await requireUnlocked())) return false;
  await removeCredential(`account:${id}`);
  await removeAsset(id);
  return true;
}
