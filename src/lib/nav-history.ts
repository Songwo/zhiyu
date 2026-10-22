import { create } from "zustand";
import { useAppStore } from "./store";
import type { ViewId } from "./types";

/** 只保留最近的页面切换，足够来回跳转，又不会无限增长。 */
const LIMIT = 50;

interface NavHistory {
  past: ViewId[];
  future: ViewId[];
}

export const useNavHistory = create<NavHistory>(() => ({ past: [], future: [] }));

// 后退/前进自身触发的切换不能再写回历史，否则会清空前进栈。
let traversing = false;

function go(from: "past" | "future") {
  // 详情是当前页面上的一层，后退先回到列表。
  if (from === "past" && useAppStore.getState().expanded) {
    useAppStore.getState().setExpanded(null);
    return;
  }
  const state = useNavHistory.getState();
  const stack = state[from];
  const target = stack[stack.length - 1];
  if (!target) return;
  const current = useAppStore.getState().view;
  const other = from === "past" ? "future" : "past";
  useNavHistory.setState({
    [from]: stack.slice(0, -1),
    [other]: [...state[other], current].slice(-LIMIT),
  } as Partial<NavHistory>);
  traversing = true;
  try {
    useAppStore.getState().setView(target);
  } finally {
    traversing = false;
  }
}

export const goBack = () => go("past");
export const goForward = () => go("future");

/** 记录页面切换，并接管 Alt+←/→ 与鼠标侧键。返回清理函数。 */
export function startNavHistory() {
  const offStore = useAppStore.subscribe((state, previous) => {
    if (traversing || state.view === previous.view) return;
    const { past } = useNavHistory.getState();
    useNavHistory.setState({ past: [...past, previous.view].slice(-LIMIT), future: [] });
  });
  // 弹窗打开时，键盘和侧键属于弹窗，不在背后切换页面。
  const blocked = () => Boolean(document.querySelector('[role="dialog"]'));
  const onKey = (event: KeyboardEvent) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || blocked()) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goBack();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      goForward();
    }
  };
  const onMouse = (event: MouseEvent) => {
    if ((event.button !== 3 && event.button !== 4) || blocked()) return;
    event.preventDefault();
    if (event.button === 3) goBack();
    else goForward();
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("mouseup", onMouse);
  return () => {
    offStore();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("mouseup", onMouse);
  };
}
