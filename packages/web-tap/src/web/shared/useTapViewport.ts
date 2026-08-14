import { useEffect, useState } from "react";

export type TapViewport = "mobile" | "compact" | "wide";

export function getTapViewport(width: number): TapViewport {
  if (width < 768) return "mobile";
  if (width < 1280) return "compact";
  return "wide";
}

export function useTapViewport(): TapViewport {
  const [viewport, setViewport] = useState(() => getTapViewport(window.innerWidth));

  useEffect(() => {
    const update = () => setViewport(getTapViewport(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return viewport;
}
