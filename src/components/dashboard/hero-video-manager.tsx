"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase/client";
import {
  finishHeroVideoUpload,
  previewHeroVideo,
  publishHeroVideoAction,
  rejectHeroVideo,
  removeHeroVideo,
  startHeroVideoUpload,
} from "@/lib/hero-video/actions";
import { VIDEO_PRIVATE_BUCKET } from "@/lib/hero-video/paths";
import type { OwnerHeroVideoState } from "@/lib/hero-video/owner-state";

const ACCEPTED_VIDEO = ["video/mp4", "video/webm"];
const ACCEPTED_POSTER = ["image/jpeg", "image/png", "image/webp"];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_POSTER_BYTES = 15 * 1024 * 1024;

/**
 * The hero video panel.
 *
 * TWO FILES, ONE ACTION, ON PURPOSE. There is no ffmpeg in this system, so
 * a poster frame cannot be extracted from the video — the owner supplies
 * one. Rather than present that as two separate uploads and let someone
 * end up with a video and no still, both are chosen together and sent in
 * one go.
 *
 * Nothing here publishes by accident: a processed video always stops at
 * "waiting for you", and only "Use this video" puts it on the menu.
 */
type Phase =
  | { name: "idle" }
  | { name: "preparing" }
  | { name: "uploading" }
  | { name: "processing" }
  | { name: "working" };

export function HeroVideoManager({
  restaurantId,
  initial,
  disabled,
}: {
  restaurantId: string;
  initial: OwnerHeroVideoState;
  disabled: boolean;
}) {
  const [state, setState] = useState(initial);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [poster, setPoster] = useState<File | null>(null);
  const [preview, setPreview] = useState<{
    videoId: string;
    src: string;
    poster?: string;
  } | null>(null);

  const busy = phase.name !== "idle" || disabled;
  const pendingId = state.pending?.videoId ?? null;

  // A pending video is private, so it cannot be linked to directly; the
  // server signs a short-lived read URL. Keyed by video id rather than
  // cleared in the effect, for the same reason as the photo manager: a
  // bare setState for the "nothing pending" case would fire on every
  // render that has none.
  useEffect(() => {
    if (!pendingId) return;
    let cancelled = false;
    void previewHeroVideo(restaurantId, pendingId).then((result) => {
      if (!cancelled && result.ok && result.video) {
        setPreview({
          videoId: pendingId,
          src: result.video,
          poster: result.poster,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [restaurantId, pendingId]);

  const previewFor = preview && preview.videoId === pendingId ? preview : null;

  function chooseVideo(files: FileList | null) {
    setError(null);
    const chosen = files?.[0] ?? null;
    if (!chosen) return;
    if (!ACCEPTED_VIDEO.includes(chosen.type)) {
      // Said plainly, because .mov is what a phone produces by default and
      // an owner will otherwise try it three times.
      setError(
        "Hero videos need to be an MP4 or WebM file. An iPhone .mov won't play for every diner, so we don't accept it.",
      );
      return;
    }
    if (chosen.size > MAX_VIDEO_BYTES) {
      setError("That video is larger than 50 MB.");
      return;
    }
    setVideo(chosen);
  }

  function choosePoster(files: FileList | null) {
    setError(null);
    const chosen = files?.[0] ?? null;
    if (!chosen) return;
    if (!ACCEPTED_POSTER.includes(chosen.type)) {
      setError("The still needs to be a JPEG, PNG or WebP image.");
      return;
    }
    if (chosen.size > MAX_POSTER_BYTES) {
      setError("That image is larger than 15 MB.");
      return;
    }
    setPoster(chosen);
  }

  async function upload() {
    if (!video || !poster || busy) return;
    setError(null);
    setNotice(null);

    setPhase({ name: "preparing" });
    const started = await startHeroVideoUpload(
      restaurantId,
      video.type,
      poster.type,
    );
    if (!started.ok || !started.videoId || !started.video || !started.poster) {
      setPhase({ name: "idle" });
      setError(started.error ?? "Could not start the upload.");
      return;
    }

    setPhase({ name: "uploading" });
    const supabase = createClient();
    const storage = supabase.storage.from(VIDEO_PRIVATE_BUCKET);
    const [videoResult, posterResult] = await Promise.all([
      storage.uploadToSignedUrl(
        started.video.path,
        started.video.token,
        video,
        {
          contentType: video.type,
        },
      ),
      storage.uploadToSignedUrl(
        started.poster.path,
        started.poster.token,
        poster,
        { contentType: poster.type },
      ),
    ]);
    if (videoResult.error || posterResult.error) {
      setPhase({ name: "idle" });
      setError("That upload didn't finish. Please try again.");
      return;
    }

    setPhase({ name: "processing" });
    const finished = await finishHeroVideoUpload(restaurantId, started.videoId);
    setPhase({ name: "idle" });
    if (!finished.ok) {
      setError(finished.error ?? "That video couldn't be processed.");
      return;
    }

    setVideo(null);
    setPoster(null);
    setState((current) => ({
      ...current,
      pending: { videoId: started.videoId! },
      failed: null,
    }));
    setNotice("Video ready. Watch it before diners see it.");
  }

  async function run(
    work: () => Promise<{ ok: boolean; error?: string }>,
    after: (current: OwnerHeroVideoState) => OwnerHeroVideoState,
    message: string,
  ) {
    if (busy) return;
    setError(null);
    setNotice(null);
    setPhase({ name: "working" });
    const result = await work();
    setPhase({ name: "idle" });
    if (!result.ok) {
      setError(result.error ?? "That didn't work. Please try again.");
      return;
    }
    setState(after);
    setNotice(message);
  }

  const statusLabel =
    phase.name === "preparing"
      ? "Preparing…"
      : phase.name === "uploading"
        ? "Uploading video and still…"
        : phase.name === "processing"
          ? "Checking the video…"
          : phase.name === "working"
            ? "Saving…"
            : null;

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="sr-only">
        {statusLabel ?? notice ?? error ?? ""}
      </p>

      {state.current && !state.pending && (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs font-medium">
            Diners see now
          </p>
          <video
            src={state.current.src}
            poster={state.current.poster ?? undefined}
            controls
            preload="none"
            className="bg-muted max-w-sm rounded-lg border"
          />
        </div>
      )}

      {state.pending ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-xs font-medium">
            Waiting for you
          </p>
          {previewFor ? (
            <video
              src={previewFor.src}
              poster={previewFor.poster}
              controls
              preload="none"
              className="bg-muted max-w-sm rounded-lg border"
            />
          ) : (
            <p className="text-muted-foreground text-sm">Loading preview…</p>
          )}
          <p className="text-muted-foreground text-sm">
            {state.current
              ? "Using this replaces the video diners see now. The old one is kept for 30 days."
              : "Using this video puts it at the top of your menu."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    publishHeroVideoAction(
                      restaurantId,
                      state.pending!.videoId,
                    ),
                  (current) => ({ ...current, pending: null }),
                  "That video is live for diners.",
                )
              }
            >
              Use this video
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => rejectHeroVideo(restaurantId, state.pending!.videoId),
                  (current) => ({ ...current, pending: null }),
                  "Discarded. Nothing changed for diners.",
                )
              }
            >
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="hero-video" className="text-sm font-medium">
              {state.current ? "Replace video" : "Add a video"}
            </label>
            <input
              id="hero-video"
              type="file"
              accept="video/mp4,video/webm"
              disabled={busy}
              onChange={(e) => chooseVideo(e.target.files)}
              className="text-sm"
            />
            <p className="text-muted-foreground text-xs">
              MP4 or WebM, up to 50 MB. Ten to thirty seconds works best — a
              diner is deciding what to eat, not watching a film.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="hero-poster" className="text-sm font-medium">
              Still image
            </label>
            <input
              id="hero-poster"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(e) => choosePoster(e.target.files)}
              className="text-sm"
            />
            <p className="text-muted-foreground text-xs">
              Shown until a diner taps play, so the video only downloads if they
              ask for it. Pick a frame that looks good on its own.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              disabled={!video || !poster || busy}
              onClick={() => void upload()}
            >
              {statusLabel ??
                (state.current ? "Upload replacement" : "Upload video")}
            </Button>
            {video && !poster && (
              <p className="text-muted-foreground text-sm">
                Choose a still image too.
              </p>
            )}
          </div>
        </div>
      )}

      {state.current && !state.pending && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Remove the video from your menu? Diners will see the menu without it.",
                )
              ) {
                return;
              }
              void run(
                () => removeHeroVideo(restaurantId),
                (current) => ({ ...current, current: null }),
                "Video removed. Diners now see the menu without it.",
              );
            }}
          >
            Remove video
          </Button>
        </div>
      )}

      {state.failed && !state.pending && (
        <Alert variant="destructive">
          <AlertDescription>
            {state.failed.error ?? "The last video couldn't be processed."}
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && !error && (
        <p className="text-muted-foreground text-sm">{notice}</p>
      )}
    </div>
  );
}
