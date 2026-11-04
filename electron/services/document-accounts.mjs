import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 50;
const LABELS = new Map([
  ...[
    "账号",
    "帐号",
    "账户",
    "账户名",
    "用户名",
    "用户",
    "邮箱",
    "邮箱地址",
    "电子邮箱",
    "username",
    "user",
    "account",
    "login",
    "email",
    "e-mail",
  ].map((key) => [key, "username"]),
  ...["密码", "口令", "登录密码", "password", "passwd", "pwd"].map((key) => [key, "password"]),
  ...[
    "网站",
    "网址",
    "地址",
    "链接",
    "登录地址",
    "登录网址",
    "url",
    "website",
    "site",
    "login url",
  ].map((key) => [key, "url"]),
  ...["名称", "站点", "平台", "服务", "name", "title", "service"].map((key) => [key, "name"]),
  ...["备注", "说明", "note", "notes"].map((key) => [key, "note"]),
]);
const labelField = (value) => LABELS.get(value.trim().toLowerCase());
const labelPattern = [...LABELS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const FIELD_PATTERN = new RegExp(`(?:^|[\\t ]+)(${labelPattern})[\\t ]*[:：=][\\t ]*`, "gi");

function plain(node) {
  if (typeof node.value === "string") return node.value;
  if (node.type === "break") return "\n";
  return (node.children ?? []).map(plain).join("");
}

function validUrl(value) {
  const raw = value.trim();
  if (!raw) return "";
  const input = /^[a-z\d.-]+\.[a-z]{2,}(?::\d+)?(?:[/#?].*)?$/i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(input);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      raw.length > 2048
    )
      return "";
    return url.href;
  } catch {
    return "";
  }
}

function unwrap(value) {
  const text = value.trim();
  return /^(`+)([^`]+)\1$/.test(text) ? text.replace(/^`+|`+$/g, "") : text;
}

/**
 * 只识别明确的账号/密码标签与表格列；全过程在本机内存运行，不访问网络。
 * 返回草稿供用户核对，缺少字段绝不从叙述中猜测。
 * @param {string} source
 * @returns {{candidates: Array<{id:string,name:string,url:string,username:string,password:string,note:string}>, warnings:string[]}}
 */
export function parseDocumentAccounts(source) {
  if (typeof source !== "string" || new TextEncoder().encode(source).byteLength > MAX_BYTES)
    throw new Error("用于提取账号的文档不能超过 1 MiB。");
  const ast = unified().use(remarkParse).use(remarkGfm).parse(source);
  const candidates = [],
    warnings = new Set();
  // 密码里的星号、下划线可能恰好被 Markdown 当成强调；保留原值供用户核对。
  // 仅移除明确字段名的格式标记，行内代码按显示值读取。
  const fieldText = (node) => {
    if (["strong", "emphasis", "delete"].includes(node.type)) {
      const text = plain(node);
      if (labelField(text)) return text;
      warnings.add("部分字段包含 Markdown 格式标记，已保留原文，请仔细核对密码。");
      return source.slice(node.position.start.offset, node.position.end.offset);
    }
    if (typeof node.value === "string") return node.value;
    if (node.type === "break") return "\n";
    return (node.children ?? []).map(fieldText).join("");
  };
  const scopes = [{ depth: 0, name: "", url: "" }];
  let current = null,
    visited = 0,
    truncated = false;
  const scope = () => scopes.at(-1);
  const draft = () => ({
    name: scope().name,
    url: scope().url,
    username: "",
    password: "",
    note: "",
  });
  const append = (candidate) => {
    if (!candidate || (!candidate.username && !candidate.password)) return;
    if (candidates.length >= MAX_CANDIDATES) {
      truncated = true;
      return;
    }
    const url = validUrl(candidate.url);
    if (candidate.url && !url)
      warnings.add("部分网址格式不正确或包含内嵌凭据，已留空，请手动核对。");
    if (!candidate.username || !candidate.password || !url)
      warnings.add("部分候选缺少网址、账号或密码，请补全并确认后再导入。");
    const limit = (value, max) => {
      if (value.length > max) {
        warnings.add("部分字段超过长度限制，已留空，请手动核对。");
        return "";
      }
      return value;
    };
    const name = candidate.name || (url ? new URL(url).hostname : "文档账号");
    candidates.push({
      id: `candidate-${candidates.length + 1}`,
      name: limit(name, 160),
      url,
      username: limit(candidate.username, 320),
      password: limit(candidate.password, 4096),
      note: limit(candidate.note, 10000),
    });
  };
  const flush = () => {
    append(current);
    current = null;
  };
  const setField = (field, value) => {
    const content = unwrap(value);
    if (field === "url") {
      if (current?.url && current.url !== content && (current.username || current.password))
        flush();
      scope().url = content;
    }
    if (field === "name") scope().name = content;
    if (current?.[field] && ["username", "password"].includes(field)) flush();
    current ??= draft();
    current[field] = content;
  };
  const block = (text) => {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^(?:[-*+] |\d+[.)]\s+)/, "");
      if (!line) {
        flush();
        continue;
      }
      const matches = [...line.matchAll(FIELD_PATTERN)];
      if (matches.length && matches[0].index === 0) {
        matches.forEach((match, index) => {
          const field = labelField(match[1]);
          setField(
            field,
            line
              .slice(match.index + match[0].length, matches[index + 1]?.index ?? line.length)
              .trim(),
          );
        });
      } else {
        const url = validUrl(line);
        if (url) setField("url", url);
      }
    }
  };
  const walk = (node) => {
    if (++visited > 50000) {
      truncated = true;
      return;
    }
    if (node.type === "heading") {
      flush();
      while (scopes.length > 1 && scope().depth >= node.depth) scopes.pop();
      scopes.push({ depth: node.depth, name: plain(node), url: scope().url });
    } else if (node.type === "table") {
      flush();
      const [head, ...rows] = node.children ?? [];
      const fields = (head?.children ?? []).map((cell) => labelField(plain(cell)));
      if (!fields.includes("username") && !fields.includes("password")) return;
      if (fields.filter(Boolean).length !== new Set(fields.filter(Boolean)).size) {
        warnings.add("表格存在重复的账号字段列，已跳过该表格，请先整理列名。");
        return;
      }
      for (const row of rows) {
        const candidate = draft();
        for (let index = 0; index < fields.length; index++) {
          const field = fields[index],
            cell = row.children[index];
          if (!field || !cell) continue;
          const link =
            field === "url" ? cell.children?.find((entry) => entry.type === "link") : null;
          candidate[field] = unwrap(link?.url ?? fieldText(cell));
        }
        append(candidate);
      }
    } else if (node.type === "paragraph" || node.type === "code") {
      block(fieldText(node));
      if (
        node.type === "paragraph" &&
        node.children?.length === 1 &&
        node.children[0].type === "link"
      ) {
        const url = validUrl(node.children[0].url);
        if (url) setField("url", url);
      }
    } else if (node.type === "thematicBreak") flush();
    else for (const child of node.children ?? []) walk(child);
  };
  walk(ast);
  flush();
  if (truncated)
    warnings.add("文档候选或结构超过处理上限，本次最多提取 50 个账号，请拆分文档后继续。");
  if (!candidates.length)
    warnings.add(
      "没有找到明确标注的账号或密码。可使用账号/密码字段，或包含这些列的 Markdown 表格。",
    );
  return { candidates, warnings: [...warnings] };
}
