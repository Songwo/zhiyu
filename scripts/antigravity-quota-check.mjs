import { readAntigravityQuota } from "../electron/services/antigravity-quota.mjs";

try {
  const result = await readAntigravityQuota();
  console.log(JSON.stringify({ ok: true, windows: result.windows.length }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
