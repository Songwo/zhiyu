/** 从 1.17.7 开始，正式版缺少 macOS 任一架构或格式都必须阻止发布。 */
export function requiresMacPackages(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("正式版本号不正确");
  const parts = version.split(".").map(Number),
    minimum = [1, 17, 7];
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}
export function macPackageNames(version) {
  return ["arm64", "x64"].flatMap((arch) =>
    ["dmg", "zip"].map((ext) => `Zhiyu-${version}-mac-${arch}.${ext}`),
  );
}
export function releaseAssetNames(version) {
  const setup = `Zhiyu-${version}-setup.exe`;
  return [
    "latest.yml",
    "SHA256SUMS.txt",
    setup,
    `${setup}.blockmap`,
    `Zhiyu-${version}-online-setup.exe`,
    `Zhiyu-${version}-portable-x64.zip`,
    `Zhiyu-${version}-browser-extension.zip`,
    ...(requiresMacPackages(version) ? [...macPackageNames(version), "latest-mac.yml"] : []),
  ];
}
