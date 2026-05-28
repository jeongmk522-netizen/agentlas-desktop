export function navigate(path: string, mode: "assign" | "replace" = "assign") {
  if (typeof window === "undefined") return;
  if (mode === "replace") window.location.replace(path);
  else window.location.assign(path);
}
