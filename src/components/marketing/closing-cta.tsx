import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The terracotta band that ends every marketing page. */
export function ClosingCta() {
  return (
    <section
      aria-labelledby="closing-heading"
      className="bg-primary text-primary-foreground"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-8 px-4 py-20 sm:px-6 sm:py-24 md:flex-row md:items-end md:justify-between">
        <h2
          id="closing-heading"
          className="mk-display max-w-2xl text-5xl sm:text-6xl"
        >
          Put a waiter on <em>every table.</em>
        </h2>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/signup"
            className={cn(
              buttonVariants({ size: "lg" }),
              "bg-primary-foreground text-primary hover:bg-primary-foreground/90",
            )}
          >
            Get started free
          </Link>
          <Link
            href="/demo"
            className={cn(
              buttonVariants({ variant: "ghost", size: "lg" }),
              "text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground",
            )}
          >
            Try the live demo
            <ArrowRight data-icon="inline-end" />
          </Link>
        </div>
      </div>
    </section>
  );
}
