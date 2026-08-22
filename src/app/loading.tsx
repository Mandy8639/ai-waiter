export default function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <div
        role="status"
        aria-label="Loading"
        className="border-muted-foreground/30 border-t-foreground h-8 w-8 animate-spin rounded-full border-2"
      />
    </div>
  );
}
