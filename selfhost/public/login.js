// 登录与首次设置：首次启动没有账号时，用服务器日志里的设置口令创建账号。
const $ = (id) => document.getElementById(id);
let setup = false;

function fail(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zhiyu": "1" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "登录失败，请稍后再试");
  return data;
}

const state = await fetch("/api/web/state", { credentials: "same-origin" }).then((r) => r.json());
if (state.username) location.replace("/");
setup = state.setup;
// 明文 http 且不是本机访问时提醒：登录密码会被同一网络里的人看到。
if (location.protocol === "http:" && !/^(localhost|127\.|\[?::1\]?$)/.test(location.hostname))
  $("insecure").hidden = false;
if (state.totp && !state.setup) $("code-row").hidden = false;
if (setup) {
  $("title").textContent = "创建网页版账号";
  $("sub").textContent = "第一次打开：设一个登录用户名和密码";
  $("token-row").hidden = false;
  $("confirm-row").hidden = false;
  $("password").autocomplete = "new-password";
  $("submit").textContent = "创建并登录";
  $("token").focus();
} else $("username").focus();

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("error").hidden = true;
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username || !password) return fail("请填写用户名和密码");
  if (!setup && state.totp && !$("code").value.trim()) return fail("请填写验证码");
  if (setup && password.length < 10) return fail("登录密码至少 10 位");
  if (setup && password !== $("confirm").value) return fail("两次输入的密码不一致");
  $("submit").disabled = true;
  try {
    await post(setup ? "/api/web/setup" : "/api/web/login", {
      token: $("token").value.trim(),
      username,
      password,
      code: $("code").value.trim(),
    });
    location.replace("/");
  } catch (error) {
    fail(error.message);
  } finally {
    $("submit").disabled = false;
  }
});
