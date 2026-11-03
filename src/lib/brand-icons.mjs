import { BRAND_FILES } from "./brand-files.mjs";
import { findChinaBank } from "../../electron/services/card-issuers.mjs";

/** @typedef {{provider?: string; oauthProvider?: string; name?: string; url?: string; host?: string; os?: string; registrar?: string; issuer?: string; address?: string}} BrandIdentity */

// 只识别明确的服务商名、官网域名和系统名，不能由任意 URL 子串触发图标。
const BRANDS = /** @type {[string, string[], string[]][]} */ ([
  [
    "openai",
    ["OpenAI", "OpenAI / ChatGPT", "ChatGPT", "ChatGPT Plus", "ChatGPT Pro", "Codex"],
    ["openai.com", "chatgpt.com"],
  ],
  [
    "claude",
    ["Claude", "Anthropic", "Anthropic / Claude", "Claude Code", "Claude Pro", "Claude Max"],
    ["claude.ai", "anthropic.com"],
  ],
  ["grok", ["Grok", "xAI", "xAI / Grok", "Grok CLI", "SuperGrok"], ["grok.com", "x.ai"]],
  [
    "gemini",
    ["Gemini", "Google Gemini", "Google / Gemini", "Google AI", "Gemini Code Assist"],
    ["gemini.google.com", "aistudio.google.com"],
  ],
  ["deepseek", ["DeepSeek", "深度求索"], ["deepseek.com"]],
  ["qwen", ["Qwen", "通义千问", "千问"], ["qwen.ai", "tongyi.aliyun.com"]],
  ["doubao", ["Doubao", "豆包"], ["doubao.com"]],
  ["minimax", ["MiniMax", "海螺"], ["minimax.io", "minimaxi.com"]],
  ["kimi", ["Kimi", "月之暗面"], ["kimi.com", "kimi.ai"]],
  ["moonshot", ["Moonshot"], ["moonshot.cn"]],
  ["zhipu", ["Zhipu", "智谱", "智谱清言", "GLM", "Z.AI"], ["z.ai", "bigmodel.cn", "zhipuai.cn"]],
  ["perplexity", ["Perplexity", "Perplexity Pro"], ["perplexity.ai"]],
  ["cursor", ["Cursor", "Cursor Pro"], ["cursor.com", "cursor.sh"]],
  ["copilot", ["Copilot", "Microsoft Copilot"], ["copilot.microsoft.com"]],
  ["githubcopilot", ["GitHub Copilot"], ["github.com/features/copilot"]],
  ["mistral", ["Mistral", "Mistral AI", "Le Chat"], ["mistral.ai"]],
  ["ollama", ["Ollama"], ["ollama.com"]],
  ["openrouter", ["OpenRouter"], ["openrouter.ai"]],
  ["huggingface", ["Hugging Face", "HuggingFace"], ["huggingface.co"]],
  ["cloudflare", ["Cloudflare", "CF", "Cloudflare Workers", "Cloudflare R2"], ["cloudflare.com"]],
  ["github", ["GitHub"], ["github.com"]],
  ["gitlab", ["GitLab"], ["gitlab.com"]],
  ["digitalocean", ["DigitalOcean"], ["digitalocean.com"]],
  ["vultr", ["Vultr"], ["vultr.com"]],
  ["hetzner", ["Hetzner"], ["hetzner.com", "hetzner.cloud"]],
  ["ovh", ["OVH", "OVHcloud"], ["ovh.com", "ovhcloud.com"]],
  ["googlecloud", ["Google Cloud", "GCP"], ["cloud.google.com"]],
  ["aws", ["AWS", "Amazon Web Services", "Amazon AWS", "亚马逊云"], ["aws.amazon.com"]],
  ["azure", ["Azure", "Microsoft Azure", "微软云"], ["azure.com", "azure.microsoft.com"]],
  ["tencentcloud", ["Tencent Cloud", "腾讯云"], ["cloud.tencent.com"]],
  ["volcengine", ["Volcengine", "火山引擎", "火山方舟"], ["volcengine.com"]],
  [
    "microsoft",
    ["Microsoft", "微软", "Outlook", "Microsoft 365"],
    ["microsoft.com", "outlook.com", "hotmail.com", "live.com", "office.com"],
  ],
  ["google", ["Google", "Google One", "Google Workspace"], ["google.com"]],
  ["alibabacloud", ["Alibaba Cloud", "Aliyun", "阿里云"], ["aliyun.com", "alibabacloud.com"]],
  ["huawei", ["Huawei", "Huawei Cloud", "华为云"], ["huaweicloud.com"]],
  ["docker", ["Docker"], ["docker.com"]],
  ["ubuntu", ["Ubuntu"], []],
  ["debian", ["Debian"], []],
  ["centos", ["CentOS"], []],
  ["almalinux", ["AlmaLinux"], []],
  ["rockylinux", ["Rocky Linux"], []],
  ["nginx", ["NGINX"], []],
  ["caddy", ["Caddy"], []],
  ["letsencrypt", ["Let's Encrypt", "LetsEncrypt"], ["letsencrypt.org"]],
  ["vercel", ["Vercel"], ["vercel.com"]],
  ["netlify", ["Netlify"], ["netlify.com"]],
  ["render", ["Render"], ["render.com"]],
  ["railway", ["Railway"], ["railway.com", "railway.app"]],
  ["namecheap", ["Namecheap"], ["namecheap.com"]],
  ["godaddy", ["GoDaddy"], ["godaddy.com"]],
  ["porkbun", ["Porkbun"], ["porkbun.com"]],
  ["gmail", ["Gmail", "Google Mail"], ["gmail.com", "googlemail.com"]],
  ["protonmail", ["Proton", "Proton Mail", "ProtonMail"], ["proton.me", "protonmail.com"]],
  ["icloud", ["iCloud", "Apple iCloud"], ["icloud.com"]],
  ["telegram", ["Telegram"], ["telegram.org", "t.me"]],
  ["notion", ["Notion"], ["notion.so"]],
  ["discord", ["Discord"], ["discord.com"]],
  ["spotify", ["Spotify"], ["spotify.com"]],
  ["netflix", ["Netflix"], ["netflix.com"]],
  ["youtube", ["YouTube", "YouTube Premium"], ["youtube.com"]],
  ["dropbox", ["Dropbox"], ["dropbox.com"]],
  ["bitwarden", ["Bitwarden"], ["bitwarden.com"]],
  ["1password", ["1Password"], ["1password.com"]],
  ["paypal", ["PayPal"], ["paypal.com"]],
  ["wise", ["Wise", "TransferWise"], ["wise.com"]],
  ["revolut", ["Revolut"], ["revolut.com"]],
  ["visa", ["Visa"], []],
  ["mastercard", ["Mastercard", "Master Card", "万事达"], []],
  ["unionpay", ["UnionPay", "银联", "中国银联"], []],
  ["americanexpress", ["American Express", "Amex", "美国运通"], []],
  ["jcb", ["JCB"], []],
  ["discover", ["Discover"], []],
]);
/** @param {unknown} value */
const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, "");
/** @param {string} id */
const result = (id) => (BRAND_FILES[id] ? { id, file: BRAND_FILES[id] } : undefined);

/** @param {BrandIdentity} [identity] */
export function resolveBrandIcon(identity = {}) {
  for (const value of [
    identity.provider,
    identity.oauthProvider,
    identity.registrar,
    identity.issuer,
  ]) {
    const bank = findChinaBank(value);
    if (bank) return result(`bank-${bank[0].toLowerCase()}`);
    if (value) {
      const match = BRANDS.find(([, aliases]) =>
        aliases.some((alias) => normalize(alias) === normalize(value)),
      );
      if (match) return result(String(match[0]));
    }
  }
  for (const value of [identity.url, identity.host, identity.address?.split("@")[1]]) {
    if (!value) continue;
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      const match = BRANDS.find(([, , domains]) =>
        domains.some(
          (domain) =>
            !domain.includes("/") &&
            (url.hostname === domain || url.hostname.endsWith(`.${domain}`)),
        ),
      );
      if (match) return result(String(match[0]));
    } catch {
      /* 无效地址使用后续名称或通用图标。 */
    }
  }
  if (identity.os) {
    const match = BRANDS.find(([, aliases]) =>
      aliases.some((alias) => normalize(identity.os).startsWith(normalize(alias))),
    );
    if (match) return result(String(match[0]));
  }
  const bank = findChinaBank(identity.name);
  if (bank) return result(`bank-${bank[0].toLowerCase()}`);
  const match = BRANDS.find(([, aliases]) =>
    aliases.some((alias) => normalize(alias) === normalize(identity.name)),
  );
  return match ? result(String(match[0])) : undefined;
}
