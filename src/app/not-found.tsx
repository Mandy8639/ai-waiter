import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <main className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          404
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="text-muted-foreground text-sm">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="text-primary mt-2 text-sm font-medium underline-offset-4 hover:underline"
        >
          Back to home
        </Link>
      </main>
    </div>
  );
}
