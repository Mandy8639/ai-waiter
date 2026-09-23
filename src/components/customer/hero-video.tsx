"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import type { ResolvedHeroVideo } from "@/lib/hero-video/resolve";

/**
 * The restaurant's hero video, at the top of the diner menu.
 *
 * POSTER FIRST, ALWAYS. The `<video>` element is not rendered at all until
 * the diner taps: until then this is an `<img>` with a play button over
 * it. `preload="none"` alone would not be enough — browsers disagree about
 * what "none" permits, and Safari in particular may still fetch metadata.
 * Not putting the element on the page is the only version of "downloads
 * nothing" that every browser implements the same way.
 *
 * That matters more here than on a marketing site. The person looking at
 * this is sitting in a restaurant on a phone, often on cellular, and they
 * came to read a menu. Several megabytes spent on a decoration they did
 * not ask for is several megabytes of someone else's money.
 *
 * Once tapped, the video is rendered with `autoPlay` so the tap that asked
 * for it is also the tap that starts it — two taps to watch a ten-second
 * clip is the kind of thing nobody complains about and everybody abandons.
 * It is NOT muted: the diner asked for this.
 */
export function HeroVideo({
  video,
  restaurantName,
}: {
  video: ResolvedHeroVideo;
  restaurantName: string;
}) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <div className="bg-muted relative w-full overflow-hidden rounded-xl">
        <video
          src={video.src}
          poster={video.poster}
          controls
          autoPlay
          playsInline
          className="w-full"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play the video from ${restaurantName}`}
      className="group bg-muted relative block w-full overflow-hidden rounded-xl"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Supabase public bucket, already sized by srcSet */}
      <img
        src={video.poster}
        srcSet={video.posterSrcSet}
        sizes={video.posterSizes}
        alt=""
        className="w-full object-cover"
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="bg-background/85 group-hover:bg-background flex size-14 items-center justify-center rounded-full shadow-sm transition-colors">
          <Play className="ml-0.5 size-6" aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}
