// <Icon name>: the app's small inline SVG set (24-unit grid, 1.75 stroke, currentColor). No icon library.
// Decorative by default (aria-hidden); pass label when the icon alone carries meaning.
import { cx } from "./cx";

const PATHS = {
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.6 6.6 12 13l8.4-6.4" />
    </>
  ),
  phone: <path d="M6.7 3.5h2.4l1.5 4.1-2 1.4a11.6 11.6 0 0 0 6.4 6.4l1.4-2 4.1 1.5v2.4a2.1 2.1 0 0 1-2.2 2.2A15.4 15.4 0 0 1 4.5 5.7a2.1 2.1 0 0 1 2.2-2.2Z" />,
  message: <path d="M5.5 4.5h13A1.5 1.5 0 0 1 20 6v8.5a1.5 1.5 0 0 1-1.5 1.5H10.5L6 19.5V16h-.5A1.5 1.5 0 0 1 4 14.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />,
  agent: (
    <>
      <rect x="2.75" y="7.5" width="7" height="9" rx="1.75" />
      <rect x="14.25" y="7.5" width="7" height="9" rx="1.75" />
      <path d="M9.75 10.5h4.5M14.25 13.5h-4.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  "chevron-right": <path d="m9.5 6 6 6-6 6" />,
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.25" />
      <path d="m15.75 15.75 4 4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  external: <path d="M13.5 4.5h6v6M19.5 4.5l-8.25 8.25M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** The icon for a Haggle channel code (email, phone, imessage, a2a). */
export const channelIcon = (channel: string): IconName => (channel === "phone" ? "phone" : channel === "imessage" ? "message" : channel === "a2a" ? "agent" : "mail");

export function Icon({ name, size = 16, label, className }: { name: IconName; size?: 16 | 20 | 24; label?: string; className?: string }) {
  return (
    <svg
      className={cx("icon", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
