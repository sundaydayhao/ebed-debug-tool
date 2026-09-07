export async function saveArtifact(
  name: string,
  content: string | Uint8Array,
  mime = "application/json",
) {
  if (window.desktopAPI) {
    const binary = typeof content !== "string";
    const data = binary
      ? btoa(Array.from(content, (b) => String.fromCharCode(b)).join(""))
      : content;
    return window.desktopAPI.saveFile({
      defaultPath: name,
      content: data,
      encoding: binary ? "base64" : "utf8",
    });
  }
  const bytes =
    typeof content === "string" ? content : new Uint8Array(content).buffer;
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true };
}
