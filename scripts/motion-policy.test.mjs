import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveMotionMode,
  motionPreset,
  normalizeMotionMode,
} from "../src/lib/motion-policy.mjs";

test("动效偏好兼容旧资料与异常值，关闭选择优先于系统", () => {
  for (const value of [undefined, null, "invalid", 1, {}, "full"])
    assert.equal(normalizeMotionMode(value), "full");
  assert.equal(effectiveMotionMode("full", false), "full");
  assert.equal(effectiveMotionMode("full", true), "reduced");
  assert.equal(effectiveMotionMode("reduced", false), "reduced");
  assert.equal(effectiveMotionMode("off", true), "off");
  assert.equal(effectiveMotionMode("off", false), "off");
});

test("轻量档只使用透明度，关闭档不设置隐藏初态且立即完成", () => {
  for (const kind of ["view", "panel", "step"]) {
    const reduced = motionPreset("reduced", kind);
    assert.deepEqual(reduced.initial, { opacity: 0 });
    assert.deepEqual(reduced.animate, { opacity: 1 });
    assert.ok(reduced.transition.duration <= 0.15);
    const off = motionPreset("off", kind);
    assert.equal(off.initial, false);
    assert.deepEqual(off.animate, { opacity: 1 });
    assert.equal(off.transition.duration, 0);
  }
});

test("完整档共用无回弹的短弹簧，步骤与页面移动幅度受控", () => {
  for (const kind of ["view", "panel", "step"]) {
    const preset = motionPreset("full", kind);
    assert.equal(preset.transition.type, "spring");
    assert.equal(preset.transition.bounce, 0);
    assert.ok(preset.transition.duration <= 0.3);
    assert.ok(Math.abs(preset.initial.x ?? preset.initial.y) <= 14);
  }
});
