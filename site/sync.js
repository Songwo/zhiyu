/* 知屿同步协议（ZSP）动画：读取 zsp-steps.json，逐步播放配对、握手、同步和攻击场景。 */
(() => {
  "use strict";
  const root = document.getElementById("zsp");
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const stage = $("zsp-stage");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LOCK =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7"/></svg>';
  const SPEEDS = [1, 1.5, 2, 0.75];

  let data = null;
  let index = 0;
  let playing = false;
  let timer = 0;
  let speedIndex = 0;
  let token = 0;
  let visible = false;
  let started = false;

  const speed = () => SPEEDS[speedIndex];
  const actor = (name) => $(`actor-${name}`);

  function icon(name) {
    return actor(name).querySelector(".zsp-icon");
  }
  /** 元素相对舞台的位置与尺寸。 */
  function box(el) {
    const a = el.getBoundingClientRect();
    const b = stage.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
  }

  function clearStage() {
    token += 1;
    for (const node of stage.querySelectorAll(".zsp-packet")) node.remove();
    $("zsp-result").hidden = true;
    for (const node of stage.querySelectorAll(".pulse")) node.classList.remove("pulse");
  }

  /** 放一个数据包并让它从 from 飞到 to；停在终点，直到切换步骤。 */
  function fly(spec, delay, mine) {
    const el = document.createElement("span");
    el.className = `zsp-packet${spec.enc ? " enc" : ""}${spec.kind ? ` ${spec.kind}` : ""}`;
    el.innerHTML = `${spec.enc ? LOCK : ""}<span></span>`;
    el.lastChild.textContent = spec.label;
    el.style.opacity = "0";
    stage.append(el);
    const size = box(el);
    const from = box(icon(spec.from));
    const to = box(icon(spec.to));
    const horizontal = spec.from !== "attacker" && spec.to !== "attacker";
    const lane = spec.lane ?? 0;
    // 水平：贴着图标内侧边缘；斜向（攻击者）：图标中心之间。
    const point = (b, side) => ({
      x: horizontal
        ? side === "start"
          ? from.x < to.x
            ? b.x + b.w + 8
            : b.x - size.w - 8
          : from.x < to.x
            ? b.x - size.w - 8
            : b.x + b.w + 8
        : b.x + b.w / 2 - size.w / 2,
      y: horizontal ? b.y + b.h / 2 - size.h / 2 + lane : b.y + b.h / 2 - size.h / 2,
    });
    const a = point(from, "start");
    const b = point(to, "end");
    if (!horizontal && spec.to !== "attacker") {
      // 攻击包停在目标图标前面一点，不盖住图标。
      b.x += (a.x < b.x ? -1 : 1) * (to.w / 2 + size.w / 2 + 6);
    }
    const place = (p) => `translate(${p.x}px, ${p.y}px)`;
    if (reduced || delay < 0) {
      el.style.transform = place(b);
      el.style.opacity = "1";
      return Promise.resolve();
    }
    el.style.transform = place(a);
    const duration = (spec.slow ? 2600 : 1500) / speed();
    const animation = el.animate(
      [
        { transform: place(a), opacity: 0 },
        { transform: place(a), opacity: 1, offset: 0.12 },
        { transform: place(b), opacity: 1 },
      ],
      {
        duration,
        delay: delay / speed(),
        easing: "cubic-bezier(0.45, 0, 0.2, 1)",
        fill: "forwards",
      },
    );
    return animation.finished.then(
      () => {
        if (mine === token) {
          animation.commitStyles?.();
          animation.cancel();
          el.style.transform = place(b);
          el.style.opacity = "1";
        }
      },
      () => {},
    );
  }

  function renderBadges(name, items, previous) {
    const list = $(`badges-${name}`);
    const before = new Set(previous ?? []);
    list.replaceChildren(
      ...items.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        if (/✓/.test(text)) li.classList.add("ok");
        if (before.has(text)) li.style.animation = "none";
        return li;
      }),
    );
  }

  function pulse(name) {
    const el = actor(name);
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 700 / speed());
  }

  function show(next, { animate = true } = {}) {
    if (!data) return;
    const previousStep = data.steps[index];
    index = (next + data.steps.length) % data.steps.length;
    const step = data.steps[index];
    const chapter = data.chapters.find((item) => item.id === step.chapter);
    clearStage();
    const mine = token;

    $("zsp-chapter").textContent = chapter.title;
    $("zsp-count").textContent = `${index + 1} / ${data.steps.length}`;
    $("zsp-title").textContent = step.title;
    $("zsp-what").textContent = step.what;
    $("zsp-why").textContent = step.why;
    $("zsp-seen").textContent = step.seen ?? "密文，读不出内容。";
    const attack = step.chapter === "attack";
    actor("attacker").hidden = !attack;
    $("wire-label").textContent = step.human
      ? "不经过网络"
      : attack
        ? "有人在这条线上"
        : "网络（可能被监听）";
    renderBadges("desktop", step.badges?.desktop ?? [], previousStep?.badges?.desktop);
    renderBadges("server", step.badges?.server ?? [], previousStep?.badges?.server);

    for (const button of $("zsp-chapters").children)
      button.setAttribute("aria-pressed", String(button.dataset.chapter === step.chapter));
    [...$("zsp-progress").children].forEach((dot, i) => {
      dot.classList.toggle("done", i < index);
      if (i === index) dot.setAttribute("aria-current", "step");
      else dot.removeAttribute("aria-current");
    });

    // 数据包按顺序依次飞过去；水平方向的两个包错开一行，避免叠在一起。
    const jobs = [];
    const instant = !animate || reduced;
    if (step.human) {
      jobs.push(
        fly(
          {
            from: step.human.from,
            to: step.human.to,
            label: step.human.label,
            kind: "human",
            slow: true,
            lane: -34,
          },
          instant ? -1 : 200,
          mine,
        ),
      );
    }
    (step.packets ?? []).forEach((packet, i) => {
      const lane = packet.from === "desktop" ? -18 : 18;
      jobs.push(fly({ ...packet, lane }, instant ? -1 : 200 + i * 1250, mine));
    });
    if (step.attacker) {
      jobs.push(
        fly(
          {
            from: "attacker",
            to: step.attacker.target,
            label: step.attacker.label,
            kind: "attack",
            enc: false,
          },
          instant ? -1 : 300,
          mine,
        ).then(() => {
          if (mine !== token) return;
          const result = $("zsp-result");
          result.textContent = step.attacker.result;
          result.hidden = false;
        }),
      );
    }
    void Promise.all(jobs).then(() => {
      if (mine === token && !instant) for (const name of ["desktop", "server"]) pulse(name);
    });
    schedule();
  }

  function dwell() {
    const step = data.steps[index];
    const base =
      3200 + (step.what.length + step.why.length) * 26 + (step.packets?.length ?? 0) * 900;
    return base / speed();
  }
  function schedule() {
    clearTimeout(timer);
    if (!playing || !data) return;
    timer = setTimeout(() => show(index + 1), dwell());
  }
  function setPlaying(value) {
    playing = value;
    const button = $("zsp-play");
    button.setAttribute("aria-pressed", String(value));
    button.textContent = value ? "❚❚ 暂停" : "▶ 自动播放";
    schedule();
  }

  function init(json) {
    data = json;
    $("zsp-count").textContent = `1 / ${data.steps.length}`;
    const chapters = $("zsp-chapters");
    for (const chapter of data.chapters) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.chapter = chapter.id;
      button.innerHTML = `${chapter.title}<small>${chapter.hint}</small>`;
      button.addEventListener("click", () =>
        show(data.steps.findIndex((s) => s.chapter === chapter.id)),
      );
      chapters.append(button);
    }
    const progress = $("zsp-progress");
    data.steps.forEach((step, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.setAttribute("aria-label", `第 ${i + 1} 步：${step.title}`);
      if (step.chapter === "attack") dot.classList.add("attack");
      dot.addEventListener("click", () => show(i));
      progress.append(dot);
    });
    $("zsp-prev").addEventListener("click", () => show(index - 1));
    $("zsp-next").addEventListener("click", () => show(index + 1));
    $("zsp-play").addEventListener("click", () => {
      started = true;
      setPlaying(!playing);
    });
    $("zsp-speed").addEventListener("click", () => {
      speedIndex = (speedIndex + 1) % SPEEDS.length;
      $("zsp-speed").textContent = `${SPEEDS[speedIndex]}×`;
      schedule();
    });
    document.addEventListener("keydown", (event) => {
      if (!root.contains(document.activeElement) && document.activeElement !== document.body)
        return;
      if (event.key === "ArrowRight") show(index + 1);
      else if (event.key === "ArrowLeft") show(index - 1);
      else if (event.key === " " && document.activeElement === document.body) {
        event.preventDefault();
        started = true;
        setPlaying(!playing);
      } else return;
    });
    window.addEventListener("resize", () => show(index, { animate: false }));
    show(0, { animate: false });
    // 进入视野后再自动播放；系统要求减少动态效果时只在点击播放后才播放。
    if ("IntersectionObserver" in window && !reduced) {
      new IntersectionObserver(
        (entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible && !started) {
            started = true;
            setPlaying(true);
            show(0);
          } else if (!visible && playing) setPlaying(false);
        },
        { threshold: 0.45 },
      ).observe(stage);
    }
  }

  fetch(root.dataset.steps)
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    })
    .then(init)
    .catch(() => {
      $("zsp-title").textContent = "动画数据加载失败";
      $("zsp-what").textContent = "请刷新页面重试，或直接阅读 docs/SYNC.md 里的文字说明。";
    });
})();
