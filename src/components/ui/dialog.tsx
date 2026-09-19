"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/20 duration-100 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 grid max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl p-4 ring-1 duration-100 outline-none sm:max-w-md",
          className,
        )}
        {...props}
      >
        {children}
        {/*
          Base UI's own guidance for a modal dialog: "render <Dialog.Close>
          inside <Dialog.Popup> so touch screen readers can escape the
          popup." Nothing in this app did, which left the AI waiter panel
          with no dismiss affordance at all for anyone not using a mouse —
          see docs/accessibility.md. Rendered here rather than per-dialog so
          no future dialog can forget it.
        */}
        <DialogClose
          aria-label="Close"
          className="ring-offset-background focus-visible:ring-ring absolute top-3 right-3 flex size-8 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </DialogClose>
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

/**
 * A dialog that behaves like a sheet: rises from the bottom edge on a
 * phone, where a centred modal would cover the menu the diner is choosing
 * from, and docks to the bottom-right corner as a panel from `sm` up.
 * Same Base UI Popup underneath — focus trapping, Escape, the close button
 * and the backdrop behave exactly like DialogContent.
 */
function DialogSheetContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogOverlay className="sm:bg-black/10" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "bg-popover text-popover-foreground shadow-float ring-foreground/10 fixed inset-x-0 bottom-0 z-50 flex h-[88dvh] max-h-[88dvh] flex-col overflow-hidden rounded-t-2xl ring-1 outline-none",
          "data-open:animate-in data-open:slide-in-from-bottom-6 data-open:fade-in-0 data-closed:animate-out data-closed:slide-out-to-bottom-6 data-closed:fade-out-0 ease-out-soft duration-200",
          "sm:inset-x-auto sm:right-4 sm:bottom-4 sm:h-[min(680px,calc(100dvh-2rem))] sm:w-[420px] sm:rounded-2xl",
          className,
        )}
        {...props}
      >
        {children}
        <DialogClose
          aria-label="Close"
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring absolute top-3 right-3 flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </DialogClose>
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-base font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogSheetContent,
  DialogTitle,
  DialogTrigger,
};
