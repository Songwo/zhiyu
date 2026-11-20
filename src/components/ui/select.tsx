import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";
import "./controls.css";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type SelectProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "defaultValue" | "onChange" | "children" | "type"
> & {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  required?: boolean;
  portalContainer?: HTMLElement | null;
  ref?: Ref<HTMLButtonElement>;
};

// 编码所有选项，让空字符串也能表示“自动识别”等可重新选择的选项。
const encodeValue = (value: string) => `option:${value}`;

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  name,
  required,
  form,
  portalContainer,
  ref,
  ...props
}: SelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const selected = options.find((option) => option.value === value);
  useImperativeHandle(ref, () => triggerRef.current!, []);

  useEffect(() => {
    if (!open) return;
    // 浮层不在 fieldset 内，父级进入忙碌状态时需主动关闭浮层。
    const observer = new MutationObserver(() => {
      if (triggerRef.current?.matches(":disabled")) setOpen(false);
    });
    if (triggerRef.current) {
      observer.observe(triggerRef.current, { attributes: true, attributeFilter: ["disabled"] });
    }
    let ancestor = triggerRef.current?.parentElement;
    while (ancestor) {
      if (ancestor.tagName === "FIELDSET") {
        observer.observe(ancestor, { attributes: true, attributeFilter: ["disabled"] });
      }
      ancestor = ancestor.parentElement;
    }
    return () => observer.disconnect();
  }, [open]);

  const changeValue = (next: string) => {
    if (disabled || triggerRef.current?.matches(":disabled")) return;
    setInvalid(false);
    onValueChange(next);
  };

  return (
    <>
      <SelectPrimitive.Root
        value={selected ? encodeValue(value) : ""}
        onValueChange={(next) => changeValue(next.slice("option:".length))}
        disabled={disabled}
        open={open && !disabled}
        onOpenChange={(next) => {
          if (!next || !triggerRef.current?.matches(":disabled")) setOpen(next);
        }}
      >
        <SelectPrimitive.Trigger
          ref={triggerRef}
          data-slot="select-trigger"
          aria-required={required || undefined}
          aria-invalid={invalid || undefined}
          className={cn(
            "ui-select-trigger group flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-body",
            className,
          )}
          {...props}
        >
          <span className="ui-select-label min-w-0 flex-1 whitespace-normal break-words">
            <SelectPrimitive.Value placeholder={placeholder}>
              {selected?.label}
            </SelectPrimitive.Value>
          </span>
          <SelectPrimitive.Icon asChild>
            <ChevronDown className="ui-select-chevron size-4 shrink-0 text-muted" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={portalContainer}>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={6}
            collisionPadding={12}
            data-slot="select-content"
            className="ui-select-content"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <SelectPrimitive.ScrollUpButton className="ui-select-scroll flex h-7 items-center justify-center">
              <ChevronUp className="size-4" />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="p-1">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={encodeValue(option.value)}
                  disabled={option.disabled}
                  textValue={option.label}
                  className="ui-select-item relative flex min-h-11 items-center gap-2 rounded-xs py-2 pl-3 pr-8 text-body"
                >
                  <span className="ui-select-label min-w-0 flex-1 whitespace-normal break-words">
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    {option.description && (
                      <span className="mt-0.5 block text-meta text-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex items-center text-ink">
                    <Check className="size-4" strokeWidth={2.5} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="ui-select-scroll flex h-7 items-center justify-center">
              <ChevronDown className="size-4" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {(name || required) && (
        <select
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
          name={name}
          form={form}
          required={required}
          disabled={disabled}
          value={value}
          onChange={(event) => changeValue(event.target.value)}
          onInvalid={(event) => {
            event.preventDefault();
            setInvalid(true);
            triggerRef.current?.focus();
          }}
        >
          {!options.some((option) => option.value === "") && <option value="" />}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
