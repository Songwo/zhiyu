import { cloneElement, isValidElement, useId } from "react";
import { Select } from "./select";
import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";
import "./controls.css";
export { Select, type SelectOption, type SelectProps } from "./select";

// React 19 passes `ref` through props, so no forwardRef wrapper is needed.
export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn("ui-input h-10 w-full rounded-sm px-3 text-body", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("ui-input min-h-20 w-full rounded-sm px-3 py-2 text-body", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("mb-1.5 block text-meta font-medium text-muted", className)} {...props} />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const generated = useId();
  const control =
    isValidElement<{ id?: string; "aria-label"?: string; "aria-labelledby"?: string }>(children) &&
    (children.type === Input ||
      children.type === Textarea ||
      children.type === Select ||
      children.type === "input" ||
      children.type === "textarea" ||
      children.type === "select")
      ? children
      : null;
  const id = control?.props.id ?? generated;
  return (
    <div>
      <Label htmlFor={control ? id : undefined}>{label}</Label>
      {control
        ? cloneElement(control, {
            id,
            ...(!control.props["aria-label"] && !control.props["aria-labelledby"]
              ? { "aria-label": label }
              : {}),
          })
        : children}
    </div>
  );
}
