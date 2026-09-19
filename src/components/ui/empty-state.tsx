import { cn } from "@/lib/utils";

/**
 * Every empty screen answers three questions: what is happening, why is it
 * empty, and what can I do. `title` is the first, `description` the second,
 * `children` (buttons or links) the third.
 */
export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {icon && (
        <div
          className="bg-secondary text-muted-foreground mb-1 flex size-12 items-center justify-center rounded-full [&_svg]:size-5"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h2 className="type-heading">{title}</h2>
      {description && (
        <p className="type-body-sm text-muted-foreground max-w-sm">
          {description}
        </p>
      )}
      {children && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}
