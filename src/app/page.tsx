import { Badge } from "@/components/ui/badge";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <main className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
        <Badge variant="secondary" className="tracking-wide uppercase">
          Foundation
        </Badge>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          AI Waiter
        </h1>
        <p className="text-muted-foreground text-lg text-balance">
          An AI waiter for restaurants.
        </p>
        <p className="text-muted-foreground max-w-md text-sm text-balance">
          This project is under active development. This page confirms the
          application foundation is up and running — the AI waiter, ordering,
          and kitchen experience come in later batches.
        </p>
      </main>
    </div>
  );
}
