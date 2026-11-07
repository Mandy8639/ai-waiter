import { Plus } from "lucide-react";

export interface FaqItem {
  q: string;
  a: string;
}

/**
 * Questions as native <details>: keyboard and screen-reader support for
 * free, and no JavaScript.
 */
export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="border-t">
      {items.map((item) => (
        <details key={item.q} className="group border-b">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-lg font-medium tracking-tight [&::-webkit-details-marker]:hidden">
            {item.q}
            <Plus
              className="text-muted-foreground size-5 shrink-0 transition-transform group-open:rotate-45"
              aria-hidden
            />
          </summary>
          <p className="text-muted-foreground max-w-2xl pb-6 text-pretty">
            {item.a}
          </p>
        </details>
      ))}
    </div>
  );
}
