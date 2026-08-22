"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — the URL
      // is still shown as selectable text nearby, so this isn't fatal.
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
      {copied ? "Copied!" : "Copy URL"}
    </Button>
  );
}
