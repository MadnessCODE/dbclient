// Project editor: name, color and icon (built-in, emoji or image).
import { useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { api, errorText, type Project, type ProjectIconDef } from "../lib/api";
import { CONN_COLORS } from "../lib/connStyle";
import { useStore } from "../store";
import { field } from "./ConnectionDialog";
import { imageToIconDataUrl, PROJECT_ICONS, ProjectIcon } from "./ProjectIcon";
import { Button, cx, Modal, Spinner } from "./ui";

const QUICK_EMOJI = ["🚀", "🛒", "🏋️", "🏥", "🎮", "🍕", "☕", "🏦", "📦", "🎓", "🏠", "🚗", "✈️", "🎵", "📱", "🤖", "🧪", "🌱", "⭐", "🔥"];

export function ProjectDialog() {
  const dlg = useStore((s) => s.projectDialog);
  if (!dlg.open) return null;
  return <ProjectForm editing={dlg.editing} key={dlg.editing?.id ?? "new"} />;
}

function ProjectForm({ editing }: { editing?: Project }) {
  const close = () => useStore.getState().setUi({ projectDialog: { open: false } });
  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState<string | null>(editing?.color ?? "blue");
  const [icon, setIcon] = useState<ProjectIconDef>(editing?.icon ?? { type: "lucide", name: "Folder" });
  const [mode, setMode] = useState<ProjectIconDef["type"]>(editing?.icon?.type ?? "lucide");
  const [emoji, setEmoji] = useState(editing?.icon?.type === "emoji" ? editing.icon.value : "🚀");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview: Project = { id: "", name, color, icon };

  const pickImage = async (file?: File) => {
    if (!file) return;
    try {
      setIcon({ type: "image", dataUrl: await imageToIconDataUrl(file) });
      setMode("image");
    } catch {
      setError("Could not read that image.");
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const saved = await api.saveProject({ id: editing?.id ?? "", name: name.trim(), color, icon });
      useStore.getState().upsertProject(saved);
      close();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? "Edit Project" : "New Project"} onClose={close} width={500}>
      <form onSubmit={save} className="space-y-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <ProjectIcon project={preview} size={44} />
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name, e.g. Acme" autoFocus required />
        </div>

        <div className="space-y-1.5">
          <span className="text-[12px] text-muted">Color</span>
          <div className="flex flex-wrap items-center gap-2">
            {CONN_COLORS.map((c) => (
              <button
                type="button"
                key={c.key}
                title={c.label}
                onClick={() => setColor(c.key)}
                style={{ background: c.hex }}
                className={cx("h-6 w-6 rounded-full", color === c.key && "ring-2 ring-fg ring-offset-2 ring-offset-panel")}
              />
            ))}
            <button
              type="button"
              title="Neutral"
              onClick={() => setColor(null)}
              className={cx("h-6 w-6 rounded-full border border-line-strong bg-muted/30", !color && "ring-2 ring-fg ring-offset-2 ring-offset-panel")}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex gap-1 border-b border-line">
            {(["lucide", "emoji", "image"] as const).map((m) => (
              <button
                type="button"
                key={m}
                onClick={() => {
                  setMode(m);
                  if (m === "emoji") setIcon({ type: "emoji", value: emoji });
                  if (m === "lucide" && icon.type !== "lucide") setIcon({ type: "lucide", name: "Folder" });
                }}
                className={cx(
                  "relative px-3 py-2 text-[13px]",
                  mode === m ? "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent" : "text-fg-2 hover:text-fg",
                )}
              >
                {m === "lucide" ? "Icons" : m === "emoji" ? "Emoji" : "Image"}
              </button>
            ))}
          </div>

          {mode === "lucide" && (
            <div className="grid grid-cols-11 gap-1">
              {Object.entries(PROJECT_ICONS).map(([key, Icon]) => {
                const active = icon.type === "lucide" && icon.name === key;
                return (
                  <button
                    type="button"
                    key={key}
                    title={key}
                    onClick={() => setIcon({ type: "lucide", name: key })}
                    className={cx(
                      "flex h-9 items-center justify-center rounded-md border",
                      active ? "border-accent bg-accent-soft text-fg" : "border-transparent text-fg-2 hover:bg-hover hover:text-fg",
                    )}
                  >
                    <Icon size={18} />
                  </button>
                );
              })}
            </div>
          )}

          {mode === "emoji" && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {QUICK_EMOJI.map((e) => (
                  <button
                    type="button"
                    key={e}
                    onClick={() => {
                      setEmoji(e);
                      setIcon({ type: "emoji", value: e });
                    }}
                    className={cx("flex h-9 w-9 items-center justify-center rounded-md text-[20px]", emoji === e ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-hover")}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[12px] text-muted">
                Or type any emoji (Win + .):
                <input
                  className={cx(field, "h-8 w-20 text-center text-[18px]")}
                  value={emoji}
                  maxLength={8}
                  onChange={(e) => {
                    setEmoji(e.target.value);
                    if (e.target.value.trim()) setIcon({ type: "emoji", value: e.target.value.trim() });
                  }}
                />
              </label>
            </div>
          )}

          {mode === "image" && (
            <div className="flex items-center gap-3">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => void pickImage(e.target.files?.[0])} />
              <Button type="button" onClick={() => fileRef.current?.click()}>
                <ImageUp size={15} /> Choose image…
              </Button>
              {icon.type === "image" ? (
                <>
                  <ProjectIcon project={preview} size={36} />
                  <button type="button" title="Remove image" onClick={() => setIcon({ type: "lucide", name: "Folder" })} className="text-muted hover:text-err">
                    <Trash2 size={15} />
                  </button>
                </>
              ) : (
                <span className="text-[12px] text-muted">PNG, JPG, SVG or WebP. It is resized to 64×64.</span>
              )}
            </div>
          )}
        </div>

        {error && <p className="selectable rounded-md bg-err/10 px-3 py-2 text-[13px] text-err">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy && <Spinner />} {editing ? "Save" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
