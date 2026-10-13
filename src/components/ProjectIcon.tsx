// Project icon: lucide, emoji or custom image on the project color.
import {
  Bot,
  Briefcase,
  Building2,
  Camera,
  Car,
  ChartLine,
  Cloud,
  Code,
  Coffee,
  Database,
  Dumbbell,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  Hospital,
  House,
  Leaf,
  Music,
  Plane,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Smartphone,
  Star,
  Store,
  Truck,
  Utensils,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "../lib/api";
import { connColor } from "../lib/connStyle";
import { cx } from "./ui";

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  Folder,
  Briefcase,
  Building2,
  Rocket,
  Globe,
  Server,
  Cloud,
  Database,
  Code,
  Bot,
  ShoppingCart,
  Store,
  Wallet,
  ChartLine,
  Dumbbell,
  Hospital,
  GraduationCap,
  Gamepad2,
  Music,
  Camera,
  Smartphone,
  Car,
  Truck,
  Plane,
  Utensils,
  Coffee,
  House,
  Leaf,
  Heart,
  Star,
  Zap,
  Shield,
  FlaskConical,
};

export const DEFAULT_PROJECT_COLOR = "#7a89a6";

export function ProjectIcon({ project, size = 20, className }: { project: Pick<Project, "icon" | "color">; size?: number; className?: string }) {
  const color = connColor(project) ?? DEFAULT_PROJECT_COLOR;
  const icon = project.icon;
  const box = { width: size, height: size };

  if (icon?.type === "image") {
    return <img src={icon.dataUrl} alt="" style={box} className={cx("shrink-0 rounded-md object-cover", className)} draggable={false} />;
  }
  if (icon?.type === "emoji") {
    return (
      <span style={{ ...box, background: `${color}2e`, fontSize: size * 0.62 }} className={cx("flex shrink-0 items-center justify-center rounded-md leading-none", className)}>
        {icon.value}
      </span>
    );
  }
  const Icon = PROJECT_ICONS[icon?.type === "lucide" ? icon.name : "Folder"] ?? Folder;
  return (
    <span style={{ ...box, background: `${color}2e`, color }} className={cx("flex shrink-0 items-center justify-center rounded-md", className)}>
      <Icon size={Math.round(size * 0.62)} />
    </span>
  );
}

/** Loads an image cropped to 64x64 so projects.json stays small. */
export async function imageToIconDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d")!;
    const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight) || 1;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
