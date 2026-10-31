/** Join class names, dropping falsy parts: cx("btn", primary && "btn-primary"). */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
