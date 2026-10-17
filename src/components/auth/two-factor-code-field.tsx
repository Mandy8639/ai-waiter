import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The 6-digit code box, shared by sign-in and setup. */
export function TwoFactorCodeField({
  error,
  disabled,
  autoFocus,
}: {
  error?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="code">Verification code</Label>
      <Input
        id="code"
        name="code"
        // Text, not number: a number field drops leading zeros and shows
        // spinners. These hints bring up the digit keyboard and let phones
        // offer a code from the authenticator.
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        placeholder="123 456"
        required
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={error ? "code-error" : undefined}
        className="tracking-widest"
      />
      {error && (
        <p id="code-error" role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
