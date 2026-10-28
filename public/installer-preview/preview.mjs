const $ = (selector) => document.querySelector(selector);
let progress = 0;
let timer;
let state = "setup";
let failedOnce = false;
let pausedByDialog = false;
const stages = ["setup", "install", "done"];

function show(next) {
  clearInterval(timer);
  state = next;
  for (const id of stages) {
    $(`#${id}`).hidden = id !== next;
    const step = $(`[data-step="${id}"]`);
    if (id === next) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  }
  $(".story").classList.toggle("working", next === "install");
  $(".story").classList.remove("paused");
  $("#scenario").disabled = next !== "setup";
  $("#skip").hidden = next !== "setup";
  if (next === "done") {
    $("#result-path").textContent = $("#directory").value.trim();
    $("#result-scope").textContent =
      $("input[name=scope]:checked").value === "user" ? "仅当前用户" : "所有用户";
    $("#result-desktop").textContent = $("#desktop").checked ? "创建" : "不创建";
    $("#result-startup").textContent = $("#startup").checked ? "开启" : "关闭";
  }
  if (next !== "setup") {
    const heading = $(`#${next} h2`);
    heading.tabIndex = -1;
    heading.focus();
  }
}

function validate() {
  const path = $("#directory").value.trim();
  // 预览只做路径格式检查；磁盘存在性和 ACL 必须交给正式安装器。
  const valid =
    /^[a-z]:\\[^<>:"/|?*]+$/i.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    !path
      .split("\\")
      .slice(1)
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      );
  $("#path-error").hidden = valid;
  $("#path-error").textContent = valid
    ? ""
    : "请输入包含文件夹的 Windows 绝对路径，例如 D:\\Apps\\Zhiyu。";
  $("#directory").setAttribute("aria-invalid", String(!valid));
  $("#start").disabled = !valid;
  return valid;
}

function updatePermission() {
  $("#permission-text").textContent =
    $("input[name=scope]:checked").value === "all"
      ? "为所有用户安装需要 Windows 管理员授权。正式安装时由系统显示授权窗口，预览不会请求权限。"
      : "仅为当前用户安装。正式安装时将检测目录写入权限，必要时再申请管理员授权。";
}

function renderProgress() {
  $("#progress-number").textContent = progress;
  $("#progress-fill").style.width = `${progress}%`;
  $(".progress-track").setAttribute("aria-valuenow", String(progress));
  const current = progress < 64 ? 0 : progress < 80 ? 1 : 2;
  $("#stage-label").textContent = ["下载程序", "校验文件", "安装程序"][current];
  $("#progress-detail").textContent = ["正在获取安装文件", "检查文件完整性", "写入程序与安装偏好"][
    current
  ];
  ["download", "verify", "install"].forEach((task, index) => {
    const element = $(`#task-${task}`);
    element.className = index < current ? "complete" : index === current ? "active" : "";
    element.querySelector("span").textContent =
      index < current ? "已完成" : index === current ? "进行中" : "等待中";
  });
}

function run() {
  state = "install";
  $(".story").classList.remove("paused");
  $("#pause").textContent = "暂停";
  $("#pause").hidden = false;
  $("#retry").hidden = true;
  $("#install-error").hidden = true;
  $("#install-heading").textContent = "正在准备你的知屿";
  $("#install-subtitle").textContent = "把需要的东西放好，很快就能见面。";
  clearInterval(timer);
  timer = setInterval(() => {
    progress = Math.min(100, progress + 2);
    renderProgress();
    if ($("#scenario").value === "offline" && progress >= 32 && !failedOnce) {
      failedOnce = true;
      clearInterval(timer);
      state = "error";
      $(".story").classList.add("paused");
      $("#install-error").hidden = false;
      $("#pause").hidden = true;
      $("#retry").hidden = false;
      $("#install-heading").textContent = "下载暂时中断了";
      $("#install-subtitle").textContent = "安装偏好已保留，可以重试。";
    } else if (progress === 100) show("done");
  }, 240);
}

$("#start").addEventListener("click", () => {
  if (!validate()) return;
  progress = 0;
  failedOnce = false;
  $("#target-path").textContent = $("#directory").value.trim();
  show("install");
  renderProgress();
  run();
});
$("#directory").addEventListener("input", validate);
document
  .querySelectorAll("input[name=scope]")
  .forEach((input) => input.addEventListener("change", updatePermission));
$("#browse").addEventListener("click", () => {
  $("#custom-path").value = $("#directory").value;
  $("#path-dialog").showModal();
});
$("#path-dialog").addEventListener("close", () => {
  if ($("#path-dialog").returnValue === "save") {
    $("#directory").value = $("#custom-path").value.trim();
    validate();
  }
});
$("#scenario").addEventListener("change", () => {
  const noDrive = $("#scenario").value === "no-drive";
  $("#directory").value = noDrive
    ? "C:\\Users\\示例用户\\AppData\\Local\\Programs\\Zhiyu"
    : "D:\\Apps\\Zhiyu";
  $("#path-hint").textContent = noDrive
    ? "模拟未检测到 D 盘：改用当前用户的本地程序目录。"
    : "优先使用 D 盘，程序资料与安装目录分别保存。";
  validate();
});
$("#pause").addEventListener("click", () => {
  if (state === "paused") return run();
  clearInterval(timer);
  state = "paused";
  $("#pause").textContent = "继续";
  $(".story").classList.add("paused");
  $("#install-heading").textContent = "已暂停，等你回来";
});
$("#retry").addEventListener("click", run);
function requestCancel() {
  pausedByDialog = state === "install";
  clearInterval(timer);
  $(".story").classList.add("paused");
  $("#cancel-dialog").showModal();
}
$("#cancel").addEventListener("click", requestCancel);
$("#close").addEventListener("click", requestCancel);
$("#keep").addEventListener("click", () => $("#cancel-dialog").close());
$("#cancel-dialog").addEventListener("close", () => {
  if (pausedByDialog) run();
  else if (state === "setup" || state === "done") $(".story").classList.remove("paused");
});
$("#confirm-cancel").addEventListener("click", () => {
  pausedByDialog = false;
  $("#cancel-dialog").close();
  show("setup");
  $("#start").focus();
});
$("#launch").addEventListener("click", () => $("#launch-dialog").showModal());
$("#restart").addEventListener("click", () => show("setup"));
$("#skip").addEventListener("click", () => {
  if (validate()) show("done");
});
validate();
