// Animated MadnessCODE logo: eyes follow the cursor and blink, the blob squishes on click.
// Geometry measured from public/madnesscode.png (256x256).
import { useEffect, useRef, useState } from "react";

const RING = "#361e0e";
const PUPIL = "#231f20";
const GREEN = "#8dc53f";

const EYES = [
  { cx: 55, cy: 111.5, r: 34.8, stroke: 6.4, pupil: { cx: 54.5, cy: 112, r: 8 } },
  { cx: 184.5, cy: 101, r: 50.2, stroke: 6.6, pupil: { cx: 186, cy: 104, r: 10.5 } },
];

const BLOB =
  "M 26 145 C 24 120, 50 98, 88 90 C 110 84, 130 78, 150 80 C 185 84, 212 120, 208 150 C 205 175, 185 205, 150 208 C 115 210, 70 200, 49 186 C 35 177, 27 160, 26 145 Z";

export function AnimatedLogo({ size = 150 }: { size?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState<{ x: number; y: number }[]>(EYES.map(() => ({ x: 0, y: 0 })));
  const [blink, setBlink] = useState(false);
  const [squish, setSquish] = useState(0);
  const [surprised, setSurprised] = useState(false);

  // pupils follow the cursor
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const svg = svgRef.current;
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const scale = box.width / 256;
      setLook(
        EYES.map((eye) => {
          const ex = box.left + eye.cx * scale;
          const ey = box.top + eye.cy * scale;
          const dx = e.clientX - ex;
          const dy = e.clientY - ey;
          const dist = Math.hypot(dx, dy) || 1;
          const max = eye.r - eye.stroke / 2 - eye.pupil.r - 4;
          const k = Math.min(1, dist / 220) * max;
          return { x: (dx / dist) * k, y: (dy / dist) * k };
        }),
      );
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // blink at random intervals
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const schedule = () => {
      t = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 140);
        schedule();
      }, 1800 + Math.random() * 2600);
    };
    schedule();
    return () => clearTimeout(t);
  }, []);

  const poke = () => {
    setSquish((n) => n + 1);
    setSurprised(true);
    setTimeout(() => setSurprised(false), 700);
  };

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      onClick={poke}
      className="about-logo cursor-pointer select-none"
      role="img"
      aria-label="MadnessCODE"
    >
      <g key={squish} className={squish ? "about-squish" : "about-breathe"} style={{ transformOrigin: "128px 200px" }}>
        <path d={BLOB} fill={GREEN} />
        {EYES.map((eye, i) => (
          <g
            key={i}
            style={{
              transformOrigin: `${eye.cx}px ${eye.cy}px`,
              transform: `scale(${surprised ? 1.12 : 1}, ${blink ? 0.08 : surprised ? 1.12 : 1})`,
              transition: "transform 120ms ease-out",
            }}
          >
            <circle cx={eye.cx} cy={eye.cy} r={eye.r} fill="#fff" stroke={RING} strokeWidth={eye.stroke} />
            <circle
              cx={eye.pupil.cx + look[i].x}
              cy={eye.pupil.cy + look[i].y}
              r={surprised ? eye.pupil.r * 0.6 : eye.pupil.r}
              fill={PUPIL}
              style={{ transition: "cx 90ms linear, cy 90ms linear, r 150ms ease-out" }}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}
