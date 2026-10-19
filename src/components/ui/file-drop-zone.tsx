"use client";

import { useId, useState } from "react";
import { ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A file picker that looks like one: a dashed drop area with a real
 * button, instead of the browser's bare "Choose Files" text, which owners
 * didn't recognise as something to click (found 2026-10-18 on the menu
 * import page). Photos can also be dragged onto it.
 *
 * The native input stays in the page (visually hidden, not display:none),
 * so the label, keyboard and screen readers all reach it as before.
 */
export function FileDropZone({
  label,
  buttonText,
  hint,
  accept,
  multiple = false,
  disabled = false,
  onFiles,
  id,
}: {
  label: string;
  buttonText: string;
  hint?: React.ReactNode;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: FileList | null) => void;
  id?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const [dragging, setDragging] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium" id={`${inputId}-label`}>
        {label}
      </span>
      <div
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) onFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/30",
          disabled && "opacity-60",
        )}
      >
        <ImagePlus
          className="text-muted-foreground size-7"
          aria-hidden="true"
        />
        <label
          htmlFor={inputId}
          className={cn(
            "bg-primary text-primary-foreground inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium transition-colors",
            "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-3",
            disabled
              ? "cursor-not-allowed"
              : "hover:bg-primary/90 cursor-pointer",
          )}
        >
          {buttonText}
          <input
            id={inputId}
            type="file"
            accept={accept}
            multiple={multiple}
            disabled={disabled}
            aria-labelledby={`${inputId}-label`}
            aria-describedby={hint ? hintId : undefined}
            onChange={(e) => {
              onFiles(e.target.files);
              // Lets the same photo be chosen again after removing it.
              e.target.value = "";
            }}
            className="sr-only"
          />
        </label>
        <p className="text-muted-foreground hidden text-xs sm:block">
          or drag {multiple ? "them" : "it"} here
        </p>
      </div>
      {hint && (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
    </div>
  );
}
