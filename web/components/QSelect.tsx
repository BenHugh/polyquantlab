"use client";

/**
 * QSelect — custom listbox dropdown, no native <select>.
 *
 * Why: browser-native <select> menus inherit the operating-system
 * dropdown chrome, which on every platform looks unmistakably like
 * "default form widget". Even with a styled trigger, the moment a user
 * clicks the dropdown they see a grey OS menu — instantly breaks the
 * Bloomberg-terminal illusion. PolyBackTest's interface uses a custom
 * popover; this is how they get that "high-end professional" feel.
 *
 * Design notes:
 *   - Mono font + tabular figures in both the trigger and the options
 *     so price-like values line up across the panel.
 *   - Electric-blue accent for the selected state (oklch ~ #2563eb) —
 *     "infrastructure" colour, distinct from our emerald-green which
 *     is reserved for PnL / win-rate / primary CTAs.
 *   - 4px corner radius, hairline border, dramatic shadow on the
 *     popover so it visually detaches from the page.
 *   - Full keyboard navigation: ↑/↓ move highlight, Enter selects,
 *     Esc / click-outside closes, Home/End jump to ends.
 *   - The popover uses absolute positioning anchored to the wrapper.
 *     For 5-15 option lists this is fine; if we ever need viewport-
 *     flipping or portal'd menus, swap in @radix-ui/react-select or
 *     @headlessui/react Listbox without changing this component's API.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface QSelectOption {
  value: string;
  label: string;
  /** Optional right-aligned hint shown in the option row (e.g. "2% fee") */
  hint?: string;
}

interface QSelectProps {
  value: string;
  onChange: (next: string) => void;
  options: QSelectOption[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Native-style tooltip on the trigger */
  title?: string;
  /** "sm" (default) ≈ 30px height; "xs" ≈ 24px for dense ConditionRow */
  size?: "sm" | "xs";
  /** Optional render override for the selected label (e.g. with icons) */
  renderSelected?: (opt: QSelectOption | undefined) => ReactNode;
}

export default function QSelect({
  value,
  onChange,
  options,
  className = "",
  placeholder = "Select…",
  disabled = false,
  title,
  size = "sm",
  renderSelected,
}: QSelectProps) {
  const sizeClass = size === "xs" ? "q-select-xs" : "";
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(() => {
    const i = options.findIndex((o) => o.value === value);
    return i >= 0 ? i : 0;
  });
  const id = useId();
  const selected = options.find((o) => o.value === value);

  // Close on outside click / esc-on-document
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Re-sync highlight when value changes from the outside (form reset etc.)
  useEffect(() => {
    const idx = options.findIndex((o) => o.value === value);
    if (idx >= 0) setHighlight(idx);
  }, [value, options]);

  // Auto-scroll highlighted row into view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const choose = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt) return;
      // Close BEFORE bubbling the change up. Previously this fired
      // onChange first which under React 19's automatic batching
      // could group setOpen(false) with the parent's resulting state
      // updates — e.g. ConditionRow swapping the op list when the
      // condition type changes — and the popover stayed visually
      // open even though the controlled state flipped. Closing local
      // state first guarantees the popover unmounts in the same
      // commit as the value change.
      setOpen(false);
      onChange(opt.value);
      // Defer focus restoration to the next paint so the focus event
      // doesn't race the popover-removal render and re-trigger any
      // ancestor focus listener mid-reconciliation.
      requestAnimationFrame(() => buttonRef.current?.focus());
    },
    [onChange, options],
  );

  const handleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(highlight);
    } else if (e.key === "Tab") {
      // Don't trap Tab — let focus leave naturally; close on the way out.
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className={`q-select-wrap ${sizeClass} ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={handleKey}
        className={`q-select-trigger ${open ? "q-select-trigger-open" : ""}`}
      >
        <span className={`q-select-value ${selected ? "" : "q-select-placeholder"}`}>
          {renderSelected
            ? renderSelected(selected)
            : selected?.label ?? placeholder}
        </span>
        <svg
          className={`q-select-chevron ${open ? "q-select-chevron-open" : ""}`}
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          aria-hidden
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          className="q-select-popover"
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            const isHighlight = i === highlight;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-idx={i}
                onMouseEnter={() => setHighlight(i)}
                onClick={(e) => {
                  // Stop the click bubbling to ancestors — defensive
                  // against any parent click handler (e.g. an "open
                  // edit menu" overlay on a condition row) that might
                  // re-open this popover.
                  e.stopPropagation();
                  choose(i);
                }}
                className={`q-select-option${
                  isHighlight ? " q-select-option-highlight" : ""
                }${isSelected ? " q-select-option-selected" : ""}`}
              >
                <span>{o.label}</span>
                {o.hint && (
                  <span className="q-select-option-hint">{o.hint}</span>
                )}
              </button>
            );
          })}
          {options.length === 0 && (
            <div className="q-select-empty">No options</div>
          )}
        </div>
      )}
    </div>
  );
}
