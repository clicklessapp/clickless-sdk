import { useEffect, useState } from "react";

/** What a request shows while its answer is being worked out. */
export const WORKING_WORDING = "Working on it…";

/** Three dots that light up in turn, drawn inline because the SDK ships no stylesheet. Still for reduced motion. */
export function WorkingDots() {
  const [still, setStill] = useState(true);
  useEffect(() => {
    setStill(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  }, []);
  const [litDot, setLitDot] = useState(0);
  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setLitDot((dot) => (dot + 1) % 3), 400);
    return () => clearInterval(timer);
  }, [still]);
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", gap: 3, verticalAlign: "middle" }}>
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "currentColor",
            opacity: still || dot === litDot ? 0.9 : 0.3,
            transition: "opacity 200ms",
          }}
        />
      ))}
    </span>
  );
}
