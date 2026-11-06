import { useLayoutEffect, type ReactNode } from "react";
import { LazyMotion, MotionConfig } from "motion/react";
import { useMotionPolicy } from "@/lib/motion";
import "./workspace-motion.css";

const loadFeatures = () => import("./motion-features").then((module) => module.default);

export function WorkspaceMotion({ children }: { children: ReactNode }) {
  const mode = useMotionPolicy();
  useLayoutEffect(() => {
    document.documentElement.dataset.motionMode = mode;
    return () => {
      delete document.documentElement.dataset.motionMode;
    };
  }, [mode]);
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig
        reducedMotion={mode === "full" ? "never" : "always"}
        transition={{ duration: mode === "off" ? 0 : 0.2 }}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
